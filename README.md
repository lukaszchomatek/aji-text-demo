# Demo tekstowe — Semantic Search w przeglądarce

Statyczna aplikacja demonstracyjna pokazująca lokalne (bezserwerowe) generowanie
embeddingów, indeksowanie oraz wyszukiwanie semantyczne w przeglądarce z użyciem
`transformers.js` i Vue (CDN). Model jest ładowany z CDN `unpkg.com`.

## Uruchomienie

1. Uruchom prosty serwer statyczny w katalogu repozytorium, np.:

```bash
python -m http.server 5173
```

2. Otwórz `http://localhost:5173` w przeglądarce.

## Funkcje MVP

- Wbudowany zestaw 60 krótkich akapitów oraz import JSON/CSV i plików tekstowych.
- Lokalny cache embeddingów w IndexedDB.
- Konfiguracja top‑K i progu podobieństwa.
- Panel metryk z czasem ładowania modelu, czasem indeksowania i czasem odpowiedzi.

## Notatki

Po pierwszym pobraniu modelu i assetów aplikacja działa offline (cache przeglądarki).
Dane nie są wysyłane na serwer.
