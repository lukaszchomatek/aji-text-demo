import { BUILTIN_DOCS } from "./data.js";

const { createApp, computed } = Vue;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DB_NAME = "semantic-search-db";
const DB_STORE = "embeddings";
const MAX_TOKENS_DEFAULT = 512;

const state = {
  sourceMode: "builtin",
  pastedContent: "",
  uploadedContent: "",
  maxTokens: MAX_TOKENS_DEFAULT,
  documents: [],
  indexedEmbeddings: new Map(),
  results: [],
  query: "",
  topK: 10,
  minScore: 0.2,
  isIndexing: false,
  indexedCount: 0,
  totalDocs: 0,
  modelLoadMs: null,
  averageIndexMs: null,
  queryTimeMs: null,
  cacheCount: 0,
  progressPercent: 0,
};

const worker = new Worker("worker.js");
const pendingRequests = new Map();

worker.addEventListener("message", (event) => {
  const { type, id, payload } = event.data;
  if (type === "modelReady") {
    state.modelLoadMs = payload.loadMs;
    return;
  }
  if (type === "embedResult") {
    const resolver = pendingRequests.get(id);
    if (resolver) {
      pendingRequests.delete(id);
      resolver(payload);
    }
  }
});

const embedText = (text) =>
  new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingRequests.set(id, resolve);
    worker.postMessage({ type: "embed", id, text, modelId: MODEL_ID });
  });

const openDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

const dbPromise = openDb();

const getCachedEmbedding = async (key) => {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
};

const saveCachedEmbedding = async (entry) => {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const countCacheEntries = async () => {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

const normalizeText = (text, maxTokens) => {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const tokens = collapsed.split(" ");
  if (tokens.length <= maxTokens) {
    return collapsed;
  }
  return tokens.slice(0, maxTokens).join(" ");
};

const hashText = async (text) => {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const toDocumentList = async (sourceMode, pastedContent, uploadedContent) => {
  if (sourceMode === "builtin") {
    return BUILTIN_DOCS;
  }
  const content = sourceMode === "upload" ? uploadedContent : pastedContent;
  if (!content) {
    return [];
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return parsed.map((item, index) => ({
      id: item.id ?? `paste-${index + 1}`,
      title: item.title ?? item.name ?? `Dokument ${index + 1}`,
      text: item.text ?? item.content ?? "",
      tags: item.tags ?? [],
    }));
  }
  if (trimmed.includes(",")) {
    const [headerLine, ...lines] = trimmed.split(/\r?\n/);
    const headers = headerLine.split(",").map((header) => header.trim());
    return lines
      .filter((line) => line.trim().length)
      .map((line, index) => {
        const values = line.split(",").map((value) => value.trim());
        const row = headers.reduce((acc, header, idx) => {
          acc[header] = values[idx];
          return acc;
        }, {});
        return {
          id: row.id ?? `csv-${index + 1}`,
          title: row.title ?? row.name ?? `Dokument ${index + 1}`,
          text: row.text ?? row.content ?? line,
          tags: row.tags ? row.tags.split("|") : [],
        };
      });
  }
  return trimmed.split(/\r?\n/).map((line, index) => ({
    id: `txt-${index + 1}`,
    title: `Dokument ${index + 1}`,
    text: line,
    tags: [],
  }));
};

const highlightQuery = (text, query) => {
  if (!query) {
    return text;
  }
  const terms = query
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) {
    return text;
  }
  const regex = new RegExp(`(${terms.join("|")})`, "gi");
  return text.replace(regex, "<mark>$1</mark>");
};

createApp({
  data() {
    return {
      ...state,
      builtinDocs: BUILTIN_DOCS,
      modelId: MODEL_ID,
    };
  },
  computed: {
    canSearch() {
      return this.query && this.indexedEmbeddings.size > 0;
    },
  },
  methods: {
    async handleFileUpload(event) {
      const file = event.target.files?.[0];
      if (!file) {
        this.uploadedContent = "";
        return;
      }
      this.uploadedContent = await file.text();
    },
    async prepareDocuments() {
      const docs = await toDocumentList(
        this.sourceMode,
        this.pastedContent,
        this.uploadedContent
      );
      this.documents = docs.map((doc) => ({
        ...doc,
        text: normalizeText(doc.text ?? "", this.maxTokens),
      }));
      this.totalDocs = this.documents.length;
      this.indexedCount = 0;
      this.progressPercent = 0;
      this.results = [];
    },
    async indexDocuments() {
      if (this.isIndexing) {
        return;
      }
      if (!this.documents.length) {
        await this.prepareDocuments();
      }
      this.isIndexing = true;
      this.indexedCount = 0;
      this.progressPercent = 0;
      const durations = [];
      for (const doc of this.documents) {
        const docHash = await hashText(doc.text);
        const key = `${MODEL_ID}:${docHash}`;
        let cached = await getCachedEmbedding(key);
        if (!cached) {
          const start = performance.now();
          const { embedding } = await embedText(doc.text);
          const duration = Math.round(performance.now() - start);
          durations.push(duration);
          cached = {
            key,
            embedding: embedding.buffer,
            metadata: { id: doc.id, title: doc.title, tags: doc.tags },
            modelId: MODEL_ID,
            docHash,
          };
          await saveCachedEmbedding(cached);
        }
        this.indexedEmbeddings.set(doc.id, {
          embedding: new Float32Array(cached.embedding),
          doc,
        });
        this.indexedCount += 1;
        this.progressPercent = Math.round((this.indexedCount / this.totalDocs) * 100);
      }
      this.isIndexing = false;
      this.cacheCount = await countCacheEntries();
      if (durations.length) {
        this.averageIndexMs = Math.round(
          durations.reduce((sum, value) => sum + value, 0) / durations.length
        );
      }
    },
    async runSearch() {
      if (!this.canSearch) {
        return;
      }
      const start = performance.now();
      const { embedding } = await embedText(this.query);
      const queryVector = new Float32Array(embedding);
      const scored = [];
      for (const { embedding: docEmbedding, doc } of this.indexedEmbeddings.values()) {
        const score = cosineSimilarity(queryVector, docEmbedding);
        if (score >= this.minScore) {
          scored.push({
            ...doc,
            score,
            highlighted: highlightQuery(doc.text, this.query),
          });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      this.results = scored.slice(0, this.topK);
      this.queryTimeMs = Math.round(performance.now() - start);
    },
    async runQuickDemo() {
      this.sourceMode = "builtin";
      await this.prepareDocuments();
      await this.indexDocuments();
    },
  },
  async mounted() {
    worker.postMessage({ type: "init", modelId: MODEL_ID });
    this.cacheCount = await countCacheEntries();
  },
}).mount("#app");

const cosineSimilarity = (a, b) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};
