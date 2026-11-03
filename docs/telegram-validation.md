# Validierung der Telegram-Erweiterung – 3. November 2026

Ausgangsstand: `main` bei `0c04c00e72dce328df67a825f5f80cf5a3c6dfc0`
(zusammengeführter PR #1). Entwicklungsbranch:
`feat/telegram-discovery-notifications`. Lokal geprüft unter Linux mit
Node 24.19.0, ohne neue Laufzeitabhängigkeiten.

## Implementiert

- Separater Aufruf `npm run notify:brack` mit dem unveränderten `BrackScanner`.
  Standard ist simulierte Zustellung; `--telegram` schaltet den echten HTTPS-
  Client ausdrücklich ein. Keine echte Zustellung mit lokalen Fixtures.
- Produktmeldungen für englisches Pokémon-TCG und deutsches «30 Jahre Jubiläum»
  mit Name, Artikelnummer, Sprache, Bestand bei Erkennung, direktem Link und
  Erkennungszeitpunkt. Ein Auftrag je Artikel, unabhängig von allen vier
  simulierten Warenkörben, Bestand und Bestelllimits.
- Persistente Outbox, exklusive Dateisperre, unveränderliche Produktsnapshots,
  sichere Wiederholungen mit Backoff/Jitter, globaler Telegram-Pause und
  Versuchsgrenze. Neue Artikel werden auch während Telegram-Pausen gespeichert.
- Zustellquittungen mit Telegram-Nachrichten-ID. Vor dem POST gespeicherter
  Zustand verhindert automatische Wiederholung bei unklarem Ausgang.
- Lokale Konfiguration aus privaten eigenen Dateien oder vollständigem lokalen
  Variablenpaar. Keine Zugangsdaten in CLI-Argumenten, Logs, Quittungen oder Git.
- Explizite Erstbestands-Baseline, gezieltes Wiederholen bestätigter Ablehnungen
  und Bestätigung einer manuell im Chat geprüften unklaren Zustellung.

## Tests

| Testgruppe | Bestandene Einzeltests |
| --- | ---: |
| bestehende fünf Testdateien, unverändert | 52 |
| Telegram-Client, Nachrichtentext, sichere Konfiguration | 9 |
| Outbox, Wiederanlauf, Deduplizierung, Sperren | 16 |
| CLI-Optionen und vollständige CLI-Prozessläufe | 3 |
| Gesamt | **80** |

`npm test` führt alle acht Testdateien erfolgreich aus. Die vollständigen
Einzeltestzahlen wurden zusätzlich über `node test/<datei>.test.js` geprüft.
`git diff --check` besteht. Die vorhandene GitHub-Actions-Matrix für Node 20,
22 und 24 bleibt unverändert; ihr Ergebnis wird nach Veröffentlichung geprüft.

Abgedeckt sind insbesondere:

- Keine Meldung für ignorierte Produkte; Englisch vor deutschem Jubiläum.
  Meldungen trotz fehlender Mengenlimits, Bestand null oder unbekannt.
- Keine erneute Meldung nach wiederholtem Scan, Namensänderung oder Neustart.
- HTTP-429 mit Body-/Header-Wartezeit, dauerhaft gespeicherter globaler Pause,
  fortgesetzter Erkennung neuer Artikel während der Pause und Pause auch nach
  ausgeschöpften Versuchen. Sichere Verbindungsfehler und gezielte Wiederholung.
- Permanente Telegram-Ablehnungen, allgemeine Timeouts, Abbrüche, 5xx,
  unerwartete Empfänger, ungültige/zu grosse Antworten, keine Weiterleitungen.
- Speicherfehler vor POST: kein Versand und später sichere Wiederholung.
  Speicherfehler nach POST-Erfolg: beim Neustart `uncertain`, kein zweiter POST.
- Keine parallelen Zustellläufe, kein Vermischen von Test/Echtbetrieb, Quelle
  oder altem Warenkorbzustand; beschädigte Outbox wird nicht zurückgesetzt.
- Dateirechte, Symlinks, unvollständige Konfiguration sowie keine Geheimnisse
  aus Fehlermeldungen in Logs oder gespeichertem Zustand. Testzustellung liest
  selbst bei vorhandenen Variablen keine Telegram-Konfiguration.

## Reale Leseprobe und Grenze der Zustellprüfung

Am 3. November 2026 um 11:01 UTC lief lokal
`NODE_USE_ENV_PROXY=1 npm run notify:brack` erfolgreich im Standard-Testmodus.
Der öffentliche BRACK-Leseabruf lieferte 33 Artikel, darunter keine passenden
Zielprodukte. Es wurden keine echten Telegram-POSTs gesendet.

Positive Fälle wurden mit synthetischen Produkten im beobachteten BRACK-Schema
geprüft. Der vollständige echte Telegram-Client wurde mit injizierten HTTP-
Antworten bis zur gespeicherten Nachrichten-ID getestet. Es wurden keine echten
Telegram-Zugangsdaten bereitgestellt oder geladen und keine reale Zustellung
an einen Bot/Chat behauptet. Diese Abschlussprobe bleibt vor einer späteren
manuellen Inbetriebnahme erforderlich.

## Bewusste Zustellgrenze

`sendMessage` bietet keine clientseitige Idempotenzgarantie. Ein Timeout oder
Absturz nach erfolgreichem externem Versand kann lokal unbestätigt bleiben.
Solche Aufträge werden angehalten, statt durch automatisches Nachsenden
Doppelmeldungen zu riskieren. Eine ausgebliebene Nachricht kann bis zur
manuellen Klärung fehlen. Dies wird als `held`/`uncertain` sichtbar und ist
ausdrücklich keine Exactly-once-Garantie für Telegram. Details und Befehle stehen
in [telegram.md](telegram.md).

## Unveränderte Systeme

Die bisherigen Scanner-, Vier-Konten-, Warenkorb-, Speicher- und Scheduler-Module
sowie alle bisherigen Testdateien wurden nicht geändert. Vorhandene CLI-Aufrufe
behalten ihr Verhalten. Keine VPS-Verbindung, Dienständerung, Containeränderung,
automatische Bereitstellung, echte Warenkorbänderung oder Bestellung wurde
ausgeführt. WOG und Changedetection bleiben unberührt. Die neue Benachrichtigungs-
CLI hat ein eigenes lokales Datenverzeichnis und startet keinen Dienst.
