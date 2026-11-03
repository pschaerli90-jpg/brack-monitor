# BRACK Pokémon Monitor

Eigenständiges Node.js-Projekt (Node 20+) ohne externe Laufzeitpakete. Der neue
Scanner liest die öffentliche BRACK-Liste. Vier getrennte Konten, Sitzungen und
Warenkörbe bleiben **Simulationen**. Der bisherige Vier-Konten-Aufruf erzeugt
weiterhin nur gespeicherte Telegram-Vorschauen. Die neue separate
Benachrichtigungs-CLI kann echte Produktmeldungen senden, siehe
[Telegram-Produktmeldungen](docs/telegram.md).
Es gibt keinen Schalter für reale Logins, Warenkorbänderungen oder Bestellungen.
WOG und Changedetection werden weder angesprochen noch konfiguriert.

## Ausführen

```sh
npm test
npm start                     # bisheriger Offline-Vier-Konten-Prototyp
npm run scan:brack             # einmaliger öffentlicher GET-Scan, nur Lesemodus
npm run monitor:brack          # Lesescans; mindestens 60 Sekunden Pause je Lauf
npm run scan:brack -- --fixture fixtures/brack-listing.html
npm run notify:brack           # neue Produktmeldungen, standardmässig Testzustellung
```

Die BRACK-Quelle ist fest auf diese URL und `sortProducts=newdesc` begrenzt:

<https://www.brack.ch/sport-freizeit/spielwaren/puzzles-spiele/spiele/sammelkarten?sortProducts=newdesc&query=pok%C3%A9mon>

`--interval-seconds 120` verändert die Pause im Watch-Modus. Ein Lauf wird komplett
abgewartet; danach beginnt die Pause. `SIGINT`/`SIGTERM` beenden den Watch-Modus
nach dem laufenden, zeitlich begrenzten Scan. Hier wurde kein Hintergrunddienst
gestartet oder installiert. Auf Node 24.5+ mit vorgeschriebenem HTTP-Proxy kann
`NODE_USE_ENV_PROXY=1` nötig sein; TLS-Prüfung und geerbte Proxy-Konfiguration
beibehalten. Auf älteren Node-Versionen in solchen Umgebungen muss ein
freigegebener Proxy-Transport bereitgestellt werden.

## Scanner und Auswahl

- `src/brack/http.js`: ausschliesslich öffentliche GETs ohne Cookies oder
  Zugangsdaten. Keine Weiterleitungen, keine Browser-Automation. Timeout 15 s
  pro Versuch einschliesslich Body, höchstens drei Versuche, exponentieller
  Backoff mit Jitter und maximal 2 MB pro Antwort. Netzwerkfehler, 408, 429 und
  5xx werden begrenzt wiederholt. `Retry-After` gilt auch für den nächsten
  geplanten Scan, wenn die geforderte Pause das interne Wartelimit übersteigt.
- 401, 403 und erkannte CAPTCHA-/Challenge-Seiten stoppen automatische Läufe.
  Es gibt keine Umgehung. Andere Fehler werden gespeichert und im Watch-Modus
  beim nächsten regulären Lauf erneut geprüft.
- `src/brack/parser.js`: liest ausschliesslich `b2c-search-products` und
  Listenmetadaten aus `b2c-search-datalayer`. Keine Skriptausführung und kein
  Speichern des vollständigen HTML oder von `INITIAL_STATE`.
- Die eindeutige BRACK-Artikelnummer `sku` ist der Produktschlüssel, nicht Titel,
  EAN oder URL. Doppelte IDs und widersprüchliche IDs werden abgelehnt.
  Erstmalig beobachtete Artikel werden mit Zeitstempeln dauerhaft erfasst.
- Englisch + Pokémon + Sammelkarten: Priorität 2. Deutsch + Pokémon +
  Sammelkarten + «30 Jahre Jubiläum»: Priorität 1. Andere Treffer werden nicht
  vorbereitet. Englisch wird für alle Konten zuerst bearbeitet.
- Die Produktsprache stammt aus dem expliziten Feld `Sprache:`. Das BRACK-Feld
  `language: de` beschreibt die Website und wird dafür nicht verwendet.
  Mehrdeutige Sprachen werden ignoriert. Marke und Kategorie stammen aus
  Themenwelt/Hersteller und Breadcrumbs. Die Jubiläumsserie erfordert das
  explizite Serienfeld oder die Phrase «30 Jahre Jubiläum» im Titel, mit
  Leerzeichen oder Bindestrichen; Jahreszahlen allein reichen nicht.
- Die Reihenfolge aus `order` und die bestätigte Sortierung `newdesc` bleiben
  erhalten. Der Scanner folgt nur gleichartigen, gleich sortierten `rel=next`-
  Links, maximal zehn Seiten. Trefferzahl, Seitenfolge und IDs werden geprüft.
  Fehlen bestätigte Folgelinks bei einer unvollständigen Liste, scheitert der
  gesamte Scan. Keine teilweise Veröffentlichung oder geratene interne API.

Der öffentliche Leseabruf vom 2. November 2026 lieferte 32 Artikel auf einer
vollständigen Seite; darunter war kein englischer oder deutscher Jubiläumstreffer.
Das bereinigte reale Schema liegt in `fixtures/brack-listing.html`. Auswahl,
Jubiläumsprodukte und Mehrseitenfälle werden zusätzlich synthetisch getestet.
Die echte Mehrseiten-Navigation muss bei Verfügbarkeit noch validiert werden.

## Mengen und vier Konten

Der vorhandene Ablauf `runFourMonitor` verwendet weiterhin genau
`mock-account-1` bis `mock-account-4`. Jedes Konto besitzt eine eigene simulierte
Sitzung, Warenkorbmenge, Historie und Fehlerablage. Ein Loginfehler betrifft nur
das jeweilige Konto; andere Konten laufen weiter.

Die Liste liefert `inventory.current`, aber keine bestätigten Bestell- oder
kontenübergreifenden Limits. Nichtpositive Bestände werden als nicht verfügbar
behandelt; fehlende/ungültige Bestände und inaktive Produkte bleiben unbekannt.
Angekündigte Nachlieferungen werden nicht als Bestand verwendet. Unbekannte
Limits werden nicht erfunden: Ein relevanter neuer Artikel und seine vier
Aufträge werden gespeichert und bleiben ohne Vorbereitung offen.

Für gezielte Simulationen können ausdrücklich lokale **Testobergrenzen** gesetzt
werden, getrennt von den Produktdaten:

```sh
cp config/limits.example.json config/limits.local.json
# Nur zum Testen: Artikelnummern, Mengen und Ablaufzeit bewusst anpassen.
npm run scan:brack -- --limits config/limits.local.json
```

Das Beispiel hat eine fiktive Artikelnummer und eine bereits abgelaufene Frist.
`limits.local.json` ist in Git ignoriert und enthält keine Zugangsdaten.
`maxPerOrder`, `globalLimit` und `expiresAt` sind je Artikel erforderlich;
`accountLimits` kann einzelne der vier Konten weiter begrenzen. Keine Einträge
und abgelaufene Einträge bedeuten unbekannte Limits. Die Datei wird beim Start
gelesen; Änderungen erfordern einen Neustart.

Das gemeinsame Budget ist `min(stock, globalLimit)`, insgesamt über alle vier
Konten. `maxPerOrder` und optionale Kontolimits begrenzen die Einzelmengen.
Konto 1 erhält zuerst die maximal zulässige Menge, dann Konto 2, 3 und 4.
Bestätigte simulierte Mengen verbrauchen Budget auch bei fehlgeschlagener
Nachrichtenvorschau. Das globale Limit wird niemals mit vier multipliziert.
Gesunkene Grenzen unter vorhandene Mengen blockieren weitere Aktionen und
verlangen manuelle Klärung; es werden keine Positionen automatisch entfernt.
Produktgruppen-, Haushalts- und Zeitraumlimits sind noch nicht abgebildet.

Im Lesemodus benötigen neue Vorbereitungen einen erfolgreichen vollständigen
Scan desselben Laufs, einen aktuell enthaltenen Artikel, höchstens 60 Sekunden
alte Daten und gültige Testlimits. Dies wird auch nach einer abgewarteten
Sitzungserstellung erneut geprüft. Ein Scanfehler, verschwundener Artikel oder
unbekannte neue Limits erlauben keinen Rückgriff auf alte Bestandsdaten.
Lokale Testobergrenzen ersetzen keine von BRACK bestätigten Regeln.

## Telegram-Vorschauen und Wiederanlauf im bisherigen Vier-Konten-Ablauf

Ein Auftrag je Artikel/Konto durchläuft `pending -> prepared -> done`.
Vorbereitungen verwenden Zielmengen und stabile Idempotenzschlüssel.
Erst nach einer bestätigten und gespeicherten simulierten Vorbereitung entsteht
mit `TelegramPreview` eine Telegram-kompatible Nachrichtenvorschau:

```text
TEST – Warenkorbvorbereitung simuliert
Produkt: Pokémon English Booster
Menge: 2
Konto: mock-account-1
Link: https://www.brack.ch/pokemon-english-booster-100001
Keine echte Warenkorbänderung, keine Bestellung.
```

Die Vorschau enthält keinen Token und wird nicht versendet. Sie liegt am Auftrag
unter `notification.message` und `notification.payload`. Ein Fehler bei ihrer
Erzeugung wird beim nächsten Lauf erneut versucht, ohne erneute Vorbereitung.
Dafür wird der zum Vorbereitungszeitpunkt gespeicherte Produktsnapshot verwendet.
Bereits vorbereitete Vorschauen können auch bei späterem Scanner-Ausfall erzeugt
werden; neue Vorbereitungen bleiben dann gesperrt. Abgeschlossene Artikel/Konto-
Paare werden nach Neustart nicht erneut vorbereitet. Titeländerungen oder
Wiederverfügbarkeit derselben Artikelnummer erzeugen keine neue Aktion.

## Dauerhafter Zustand und Sperren

| Aufruf | Zustand |
| --- | --- |
| `npm start` | `data/four-accounts/state.json` |
| `scan:brack` / `monitor:brack` | `data/brack-read-only/state.json` |
| `scan:brack -- --fixture …` | `data/brack-fixture/state.json` |
| alter Einzelkonto-Ablauf `runMonitor` | weiterhin separat, keine Migration |

Eine exklusive `run.lock` je Zustandsverzeichnis umfasst Scan, Mengenplanung,
Adapteraufrufe und Speicherung. Ein paralleler Prozess mit demselben Zustand
scheitert vor dem Scan. Alle vier Konten müssen denselben Zustand verwenden;
verschiedene Verzeichnisse/Hosts koordinieren keine gemeinsamen Limits.
Beschädigte Zustände werden abgewiesen und nicht automatisch zurückgesetzt.
Dateien werden mit Modus 0600 über eindeutige temporäre Dateien, `fsync`,
Umbenennen und Verzeichnissynchronisierung gespeichert (Linux).

Nach einem harten Prozessabbruch kann `run.lock` bestehen bleiben. Erst nach
Prüfung, dass kein Lauf mehr aktiv ist, manuell entfernen. Keine automatische
Übernahme alter Sperren. Datenverzeichnisse sind in Git ignoriert. Es gibt noch
keine verteilte Datenbank, Retention oder Absicherung gegen bösartige lokale
Symlinks. Logs sind JSON-Zeilen; Fehler führen beim Einzelaufruf zu Exitcode 1,
fehlende Testlimits sind ein dokumentierter blockierter Zustand.

## Tests und Produktionsgrenzen

`npm test` führt alle Testdateien aus. Die bisherigen 52 Einzeltests bleiben
erhalten. Neue Tests decken reale bereinigte BRACK-Daten, synthetische Auswahl,
Paginierung, Schemafehler, HTTP-Grenzen/Backoff, Zugriffsschutz, Testlimits,
Aktualität, Zustandsfehler, vier Konten, Nachrichten und Wiederanläufe ab.
Alle Tests verwenden lokale Daten und injizierte Transporte; sie benötigen weder
BRACK-Zugriff noch Zugangsdaten. GitHub Actions ist für Node 20, 22 und 24
konfiguriert. Den Scanner-Stand dokumentiert [docs/validation.md](docs/validation.md),
die Telegram-Erweiterung [docs/telegram-validation.md](docs/telegram-validation.md).

Vor produktivem Betrieb fehlen insbesondere:

1. Bestätigung der erlaubten Datenquelle und des beobachteten Schemas einschliesslich
   echter Mehrseitenfälle und tatsächlich angebotener Jubiläumsprodukte.
2. Verifizierte Bestell-, Konto-, Produktgruppen-, Haushalts- und Zeitraumlimits
   von BRACK sowie Bedeutung und Aktualität der Bestandsangaben.
3. Ein separat freizugebender realer Vier-Konten-Adapter mit sicher verwalteten
   Sitzungen, Ablauf/Erneuerung, serverseitigem Warenkorbabgleich und Behandlung
   unklarer Ergebnisse nach einem Prozessabbruch. Hier existieren ausschliesslich
   Mocks; die vier IDs sind keine verbundenen BRACK-Konten.
4. Sichere lokale Telegram-Konfiguration und ein bewusst gestarteter, manuell
   freigegebener Benachrichtigungsprozess. Der separate echte Transport ist
   implementiert, wurde hier aber ohne reale Zugangsdaten und mit simulierten
   HTTP-Antworten geprüft. Telegram dedupliziert nicht anhand eines frei gewählten
   Idempotenzschlüssels; unklare Zustellungen bleiben deshalb zur Prüfung stehen.
5. Betriebsfreigabe, Monitoring, Datensicherung, Retention und gegebenenfalls
   koordinierter Speicher für mehrere Hosts. Keine Dienste wurden ausgerollt.

Ein Checkout- oder Bestellmodul ist nicht enthalten. Keine Zugangsdaten in
Fixtures, Konfigurationen oder GitHub speichern.
