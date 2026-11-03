# Validierung am 2. November 2026

## Umfang und Ergebnis

Entwicklung auf `feat/brack-read-only-monitor`, ausgehend von
`6ecb87998e80be39b9fcf81098fed5902f9a4411` auf `main`.
Lokal geprüft mit Node **24.19.0** unter Linux. Kein Deployment,
kein laufender Watch-Prozess, keine realen Kontologins, Warenkorbänderungen,
Bestellungen oder Telegram-Nachrichten. WOG und Changedetection wurden nicht
verändert.

| Prüfung | Ergebnis |
| --- | --- |
| Ursprüngliche Einzelkonto-Tests | 11 bestanden, Datei unverändert |
| Ursprüngliche Vier-Konten-Tests | 16 bestanden, Datei unverändert |
| BRACK-Parser, Scanner, Testlimits | 7 bestanden |
| HTTP-Transport und Wiederholungen | 4 bestanden |
| Lesemodus, Nachrichten, Persistenz, Scheduler | 14 bestanden |
| Gesamt | **52 Einzeltests bestanden** |
| `npm test` | alle fünf Testdateien erfolgreich |
| `git diff --check` | erfolgreich |

Die Einzeltests wurden zusätzlich direkt mit `node test/<datei>.test.js`
ausgeführt, um die vollständigen Testzahlen zu sehen. Die lokale
`node --test`-Ausgabe fasst auf Dateiebene zusammen.

GitHub Actions ist mit Node 20, 22 und 24 konfiguriert. Diese Matrix ist eine
zusätzliche Prüfung nach Veröffentlichung des Branches; die oben genannten
lokalen Ergebnisse behaupten keine bereits abgeschlossene CI-Ausführung.

## Reale Leseprobe

Die angegebene URL lieferte über einen öffentlichen GET HTTP 200. Der Abruf
erforderte weder Cookies noch Zugangsdaten oder Umgehung von Zugriffsschutz.
`NODE_USE_ENV_PROXY=1 npm run scan:brack` lief am 2. November um 21:34 UTC
erfolgreich durch. Die gespeicherten Listenmetadaten bestätigten 32 Artikel,
Seite 1 und `newdesc`.

Aktuell enthielt die vollständige Liste keine englischen Pokémon-TCG-Produkte
und keine deutschen Produkte der Serie «30 Jahre Jubiläum». Daher gab es in der
Live-Probe keine Vorbereitung und keine Nachrichtenvorschau. Der bereinigte
öffentliche Datenausschnitt wird als Parser-Fixture verwendet; keine vollständige
Seitenkopie oder Sitzungsdaten sind im Repository enthalten.

## Positive Simulation

Zusätzlich wurde die neue CLI mit synthetischem BRACK-HTML, einem englischen
Artikel, Bestand 12, Testlimit 2 je Konto und gemeinsamem Limit 5 ausgeführt.
Ergebnis: ein erkannter Zielartikel, Zielmengen **2 / 2 / 1 / 0**, drei gespeicherte
Nachrichtenvorschauen, ein wegen ausgeschöpften Budgets offener Auftrag,
keine Fehler. Die Vorschauen enthalten Produktname, Menge, Konto und Produktlink.
Alle Ergebnisse liegen ausschliesslich im ignorierten lokalen Datenverzeichnis.

## Geprüfte Fehlerfälle

Tests prüfen fehlende und abgelaufene Limits, fehlende/negative Bestände,
mehrdeutige Produktsprache, falsche Sortierung, Schemaänderungen, unvollständige
Seiten und verschobene Artikel zwischen Seiten. HTTP-Tests prüfen begrenzte
Wiederholungen, `Retry-After`, Timeouts, Antwortgrössen, 401/403 und Redirects.

Integrationstests prüfen Sperren vor dem Scan, getrennte Konten und Zustände,
globale Mengenlimits, Aktualitätsgrenzen auch nach Sitzungserstellung,
fehlgeschlagene Scans ohne Vorbereitung mit alten Daten, Wiederanläufe ohne
doppelte Warenkorbvorbereitung, gespeicherte Produktsnapshots für Nachrichten
und Abweisung beschädigter Zustände.

## Vor Produktion offen

- Echtes Mehrseitenverhalten und reale englische/Jubiläumsartikel gegen die
  erlaubte BRACK-Datenquelle validieren. Die Probe bestätigte eine einzelne Seite;
  Mehrseiten- und Zielproduktfälle sind zusätzlich synthetisch getestet.
- BRACK-seitige Bestell-, Konto- und gemeinsame Limits verbindlich klären.
  Lokale Testobergrenzen sind keine Bestätigung dieser Regeln. Weitere
  Produktgruppen-, Haushalts- und Zeitraumlimits fehlen.
- Reale Sitzungs- und Warenkorbadapter, Serverabgleich und sichere
  Geheimnisverwaltung gesondert entwickeln und freigeben. Der Code verwendet
  weiterhin genau vier isolierte simulierte Konten.
- Reale Telegram-Zustellung samt sicherem Token und Behandlung unklarer
  Zustellergebnisse entwickeln. Aktuell funktioniert die gespeicherte Vorschau.
- Betrieb, Sicherung, Retention und gegebenenfalls verteilte Koordination klären.

Die Implementierung enthält absichtlich keinen produktiven Warenkorb- oder
Bestellmodus. Alle bisher real ausgeführten BRACK-Aktionen waren lesende GETs.
