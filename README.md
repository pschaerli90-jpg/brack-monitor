# BRACK Pokémon Monitor

Eigenständiges Node.js-Projekt für Node 20+. Der öffentliche BRACK-Scanner,
Telegram-Outbox und Scheduler werden gemeinsam weiterverwendet. Keine Bestellungen,
kein Checkout und keine automatische Befüllung echter Warenkörbe.

## Telegram-Produktmeldungen

Der Benachrichtigungsmodus berücksichtigt ausschliesslich Pokémon-Produkte in
Englisch (EN), Deutsch (DE) und Französisch (FR). Alle drei Sprachen haben den
gleichen Rang; es gibt keine Beschränkung auf eine deutsche Jubiläumsserie.
Andere Marken, andere und mehrdeutige Sprachen werden ausgeschlossen. Quelle
bleibt die bestehende öffentliche BRACK-Sammelkartenliste mit newdesc-Sortierung.

Neue Meldungen enthalten das von BRACK gelieferte Hauptbild, Produktname,
Artikelnummer, Sprache, Lagerbestand und direkten Produktlink. Die Erkennungszeit
bleibt im lokalen Zustand und in Logs, erscheint aber nicht in der Nachricht.
Die Auslieferung erfolgt als Telegram sendPhoto mit Bildtext. Fehlt ein gültiges
BRACK-Bild, bleibt der Auftrag ohne Versandversuch vorgemerkt; es wird kein Bild
erraten und keine zusätzliche Textmeldung erzeugt.

~~~sh
npm ci
npm test
npm run notify:brack -- --test --fixture fixtures/brack-listing.html
npm run notify:brack -- --test --watch --interval-seconds 30
~~~

Standard im Telegram-Watch-Modus sind 30 Sekunden Pause **nach** dem vollständigen
Lauf. Neue Meldungen werden im selben Lauf verarbeitet. Der Scheduler wartet jeden
Lauf ab; es gibt keine parallelen Scans oder Zustellungen. HTTP-429-Pausen und
Stopps bei CAPTCHA/Zugriffsschutz bleiben wirksam. Ohne --watch endet ein Aufruf
nach einem Scan. Standard ist simulierte Telegramzustellung ohne Zugangsdaten.

Echter Versand benötigt ausdrücklich --telegram und eine geschützte lokale
Konfiguration. Anleitung, Wiederanlauf und Migration stehen in
[docs/telegram.md](docs/telegram.md).

## Umstellung ohne erneute Bestandsmeldungen

Das vorhandene Zustandsverzeichnis weiterverwenden und vorher lokal sichern;
keinen frischen Zustand als vermeintliche Migration anlegen. Version-1-Outboxen
werden unter der vorhandenen exklusiven Sperre auf Version 2 umgestellt.
Bestehende Artikelnummern, Zustellquittungen, Sperren, Versuche und Zeitstempel
bleiben erhalten. Ein erster vollständiger Scan bildet zusätzlich eine Baseline
für zuvor ausgeschlossene DE-/FR-Produkte. Diese werden nicht nachgemeldet.
Der erste Scan kann dabei auch gerade neu erschienene Produkte zurückhalten,
weil Version 1 keine Beobachtungen ausgeschlossener Produkte gespeichert hat.
Eine unvollständige/fehlgeschlagene Liste beendet diese Baseline nicht.

Version 2 merkt alle beobachteten Artikelnummern, auch ausgeschlossene Produkte.
Danach werden nur tatsächlich neue, passende Artikel gemeldet. Fehlerhafte
Zustände werden nicht zurückgesetzt. Unklare Zustellungen werden nicht blind
wiederholt. Fehlende alte Zustandsdaten können nicht aus GitHub rekonstruiert werden.

## Vier echte Kontositzungen: nur manueller Lesetest

Der optionale Kontoadapter unterstützt vier getrennte lokale Cookie-Jars und
Identitäts-/Warenkorb-Lesezugriffe. Er hat keinen Schreibtransport, keinen
Schreibschalter und keinen automatischen Warenkorbprozessor. Eine lokale
Freigabedatei kann keine Mutationen aktivieren.

Das Beispiel ist absichtlich unkonfiguriert. Authentifizierte BRACK-Endpunkte und
Schemata sind mangels echter Sitzung nicht live bestätigt. Die spätere manuelle
VPS-Einrichtung und ihre Grenzen stehen in
[docs/brack-accounts.md](docs/brack-accounts.md).

## Bisherige Prototypen und Dienste

~~~sh
npm start                     # bestehender Offline-Vier-Konten-Prototyp
npm run scan:brack             # öffentlicher Lesescan, simulierte Warenkörbe
npm run monitor:brack          # bestehender Lesescanner, mindestens 60 Sekunden
~~~

Diese bisherigen Betriebsarten bleiben unverändert, einschliesslich ihrer
historischen Auswahlregeln und Mock-Warenkörbe. Sie sind keine echten Logins oder
Warenkorbänderungen. Die neue Sprachauswahl gilt für Telegram-Produktmeldungen.
Es werden keine laufenden Prozesse, VPS-Dateien, WOG oder ChangeDetection geändert.
Dieses Repository führt weder automatische Bereitstellung noch Merge aus.

## Tests und Grenzen

Alle Tests verwenden lokale Daten und injizierte Transporte. Die optionale
Playwright-Abhängigkeit wird nur für die ausdrückliche Kontoanmeldung/-prüfung
benötigt; Monitoring und Telegram verwenden sie nicht. CI prüft Node 20, 22, 24.

Aktuelle Ergebnisse: [Telegram-Update](docs/telegram-update-validation.md) und
[Kontolesetest](docs/brack-accounts-validation.md).
Historische Prüfstände: [Scanner](docs/validation.md),
[erste Telegram-Erweiterung](docs/telegram-validation.md).

Keine Zugangsdaten, Cookie-Dateien oder authentifizierten Netzwerkexporte in Git
oder GitHub speichern. Echte Telegramzustellung und echte BRACK-Kontositzungen
wurden hier nicht verwendet; Bildtransport/Fehlerfälle sind automatisiert mit
synthetischen Telegramantworten geprüft.
