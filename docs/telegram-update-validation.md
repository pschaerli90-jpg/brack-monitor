# Telegram-Update – Prüfung vom 7. November 2026

Der bestehende PR #4 wird auf die endgültigen Anforderungen umgestellt:
Pokémon EN/DE/FR gleichberechtigt, echtes BRACK-Hauptbild, kein Erkennungszeitpunkt
in Telegram, 30-Sekunden-Pause nach abgeschlossenem Lauf, keine automatische
Warenkorbbefüllung. Die vorgeschlagene Befüllungslogik und ihre 15 Tests wurden
entsprechend entfernt; die vorhandenen Mock-Betriebsarten bleiben unverändert.

## Automatisierte Prüfung

112 Einzeltests bestehen, keine übersprungen. Node 24.22.1 wurde mit
node --test --test-isolation=none geprüft, um alle Einzeltests zu zählen.
Zusätzlich bestehen der vollständige Testsatz unter Node 20.20.2 und 22.23.4
sowie npm test. git diff --check besteht.

Abgedeckt sind insbesondere:

- EN/DE/FR ohne Priorität, normale deutsche Serien eingeschlossen,
  andere Marken/Sprachen und mehrdeutige Sprache ausgeschlossen.
- Echter beobachteter MAIN-Bildpfad, strenge Asset-URL-Prüfung und fehlende Bilder.
- sendPhoto mit Bildtext: Name, Artikelnummer, Sprache, Bestand und Link;
  kein angezeigter Erkennungszeitpunkt, interne firstSeenAt-/Log-Aufbewahrung.
- Konservativer v1-v2-Übergang mit vollständiger Erstbaseline: bekannte Artikel,
  Zustellquittungen, Sperren und Versuche bleiben erhalten. DE-/FR-Bestandsartikel
  werden nicht nachgemeldet; ein fehlgeschlagener Scan beendet die Baseline nicht.
- Keine erneute Meldung nach Neustart, Titel- oder Sprachänderung.
- Fehlende Bilder ohne POST/Versuchszähler, spätere Bildaufnahme ohne Doppelmeldung.
- Keine Parallelläufe; Verarbeitung neuer Meldungen vor der nächsten 30-Sekunden-
  Pause; BRACK-Zugriffsschutz und Telegram-429-/Unklarheitsbehandlung erhalten.
- Keine Schreibmethoden im echten Kontoadapter, Schreibschalter auch mit
  vorhandener synthetischer Freigabedatei abgewiesen; 13 reine Kontolesetests.

Die geänderte Testanzahl ersetzt den älteren Stand von 111/112 Tests für die
inzwischen verworfene Warenkorbautomatik. Es wird nicht behauptet, entfernte
Schreibabläufe seien weiterhin Funktionsumfang.

## Öffentliche Leseprobe und Grenzen

Die öffentliche BRACK-Liste wurde ohne Anmeldung lesend abgerufen (HTTP 200).
Das beobachtete MAIN/sizes-Schema ist in fixtures/brack-product-image.json auf
öffentliche Produktfelder reduziert. Der Pokémon-FR-Artikel 2054891 verweist auf
https://assets.brack.ch/images2/8/0/9/412765908/412765908_xl.jpg.
Ein öffentlicher Leseabruf bestätigte HTTP 200, image/jpeg und 53611 Bytes.
Keine Bildadresse wurde aus einer Artikelnummer geraten.

Kein echter Telegramversand und keine echten Kontositzungen wurden verwendet.
Telegramantworten, Empfänger und Fehlerfälle sind synthetisch getestet. Die
Erreichbarkeit des Assets beweist keine reale Zustellung an einen Telegram-Chat.
Die private Kontoschnittstelle bleibt lokal zu verifizieren.

## GitHub-Speicherung und Betrieb

Der frühere Commit-Aufruf wurde identisch wiederholt und lieferte erfolgreich
Commit 06215bf5813c8ef29ff5b3ff7010b82c9a987f4d für die damalige zusätzliche
CLI-Schreibsperre. Die ursprüngliche Fehlermeldung wurde im vorherigen Schritt
nicht ausgegeben und ist nicht verlässlich rekonstruierbar; eine Ursache wird
nicht erfunden. Der abschliessende Commit fasst die nun gültige Präzisierung
zusammen; sein tatsächlicher GitHub-Hash wird im PR/Abschlussbericht genannt.

Keine SSH-Befehle, kein codex --yolo, keine BRACK-Zugangsdaten, kein Deployment,
keine Produktionsdienständerung und kein Merge. WOG und ChangeDetection bleiben
unberührt. Die Anleitung beschreibt ausschliesslich eine spätere manuelle
Einrichtung; den vorhandenen Telegramzustand bei der Umstellung beibehalten.
