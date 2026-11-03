# Unabhängige Telegram-Produktmeldungen

Die neue CLI verwendet denselben `BrackScanner` wie der bestehende Lesescanner.
Sie hat einen eigenen Zustand und ruft keine Sitzungs- oder Warenkorbadapter auf.
`npm start`, `scan:brack` und `monitor:brack` behalten ihr bisheriges Verhalten.
An laufenden VPS-Prozessen, WOG und Changedetection wird nichts geändert.
Das Repository enthält keine Deployment-Automation.

## Meldung und Auswahl

Jede erstmals erkannte Artikelnummer eines passenden englischen Pokémon-TCG-
Produkts oder deutschen Produkts der Serie «30 Jahre Jubiläum» erzeugt genau
einen persistenten Meldungsauftrag. Englisch hat Vorrang. Andere Produkte werden
ignoriert. Die Meldung benötigt weder bekannte Mengenlimits noch einen
vorbereiteten Warenkorb und wird auch bei Bestand null oder unbekannt erzeugt.

```text
Neues BRACK Pokémon-TCG-Produkt
Produkt: Pokémon English Booster
Artikelnummer: 100001
Sprache: Englisch
Lagerbestand (bei Erkennung): 12
Link: https://www.brack.ch/pokemon-english-booster-100001
Erkannt am: 2026-11-03T12:00:00.000Z
```

Bestand und Produktname stammen aus dem unveränderlichen Erkennungssnapshot.
Eine später wiederholte Nachricht behauptet deshalb keinen aktuellen Bestand.
Titeländerungen, Wiederverfügbarkeit und wiederholte Scans derselben Artikelnummer
erzeugen keine weitere Meldung. Es entstehen keine vier Meldungen je Konto.
Die Nachricht ist Klartext ohne Telegram-HTML-/Markdown-Interpretation.

## Testmodus

```sh
npm run notify:brack
npm run notify:brack -- --fixture fixtures/brack-listing.html
npm run notify:brack -- --test --watch --interval-seconds 120
```

Standard ist immer `--test`: BRACK wird öffentlich gelesen, Telegram-Zustellung
wird ausschliesslich simuliert. Dieser Modus lädt keine Telegram-Zugangsdaten,
selbst wenn entsprechende Umgebungsvariablen vorhanden sind. `--fixture` liest
lokales HTML und ist nur im Testmodus erlaubt. Echte Zustellung mit einer Fixture
wird bereits beim Start abgewiesen.

Ein Aufruf führt einen Scan aus. `--watch` wartet jeden Lauf vollständig ab und
pausiert anschliessend mindestens 60 Sekunden. BRACK-Wartezeiten können
diese Pause verlängern. Telegram-Pausen sperren nur den Versand; neue Artikel
werden währenddessen weiterhin erkannt und gespeichert. SIGINT/SIGTERM beenden nach dem laufenden begrenzten
Aufruf. Es wird kein Hintergrunddienst installiert oder gestartet.

## Sichere lokale Konfiguration für echte Zustellung

Echte Zustellung erfordert ausdrücklich `--telegram` und eine gültige lokale
Konfiguration. Tokens und Chat-IDs gehören weder in CLI-Argumente noch in Logs,
Fixtures, Issues, PRs oder GitHub. Keine echten Werte aus Beispielen übernehmen.

Für eine spätere manuelle Inbetriebnahme unter Linux:

```sh
umask 077
cp config/telegram.example.json config/telegram.local.json
chmod 600 config/telegram.local.json
# Datei mit einem lokalen Editor befüllen; keine Werte in die Shell-History schreiben.
npm run notify:brack -- --telegram --config config/telegram.local.json
```

Die JSON-Datei hat ausschliesslich `botToken` und `chatId` als Zeichenketten.
Erlaubt sind eine numerische Chat-ID, einschliesslich negativer Gruppen-IDs,
oder ein Telegram-Kanalname mit `@`. Der Bot muss im Zielchat berechtigt sein;
bei einem privaten Chat muss der Benutzer den Bot zuvor selbst gestartet haben.

Alternativ kann `BRACK_TELEGRAM_CONFIG` den lokalen Dateipfad vorgeben. Die Datei
muss regulär sein, dem Prozessbenutzer gehören, höchstens 16 KiB gross sein und
darf keine Gruppen-/Fremdrechte besitzen (empfohlen 0600, auch 0400 ist möglich).
Symbolische Links werden nicht verfolgt. Syntax-, Berechtigungs- und Lesefehler
werden ohne Dateiinhalte ausgegeben. Die strikte Dateiprüfung richtet sich an
POSIX/Linux, passend zum VPS.

Alternativ sind die beiden Prozessvariablen `TELEGRAM_BOT_TOKEN` und
`TELEGRAM_CHAT_ID` gemeinsam zulässig, bereitgestellt durch eine sichere lokale
Laufzeitkonfiguration. Keine automatische `.env`-Ladung. Teilkonfigurationen oder
eine gleichzeitige Datei-/Variablenkonfiguration werden abgelehnt. Die Datei
`config/telegram.local.json`, weitere `*.local.json` und `.env` sind Git-ignoriert.
Der Code speichert weder Token noch Chat-ID im Zustand oder in Quittungen.

HTTP geht ausschliesslich an `https://api.telegram.org/.../sendMessage`:
ein POST pro Versuch, keine Weiterleitung, Timeout 10 Sekunden einschliesslich
Body, maximal 64 KiB Antwort. TLS-Prüfung bleibt aktiv. Auf Node 24.5+ kann in
Umgebungen mit vorgeschriebenem HTTP-Proxy `NODE_USE_ENV_PROXY=1` nötig sein.
Telegram verlangt den Token im HTTPS-URL-Pfad; der Client protokolliert weder
diese URL noch rohe HTTP-/Netzwerkfehler oder Telegram-Beschreibungen.

## Zustand und Deduplizierung

| Modus | Standard-Zustand |
| --- | --- |
| echte Zustellung | `data/telegram-discovery/state.json` |
| Testzustellung mit BRACK-GET | `data/telegram-discovery-test/state.json` |
| lokale Fixture | `data/telegram-discovery-fixture/state.json` |

`--state-dir` kann für isolierte lokale Tests ein anderes Verzeichnis innerhalb
des Projekts wählen. Für einen Bot/Chat muss dauerhaft dasselbe kanonische
Verzeichnis genutzt werden. Separate Kopien, neue Verzeichnisse oder mehrere
Hosts teilen keine Deduplizierung. Der Zustand darf bei Neustarts oder einem
späteren manuellen Release nicht gelöscht werden. Nach einer Änderung von Bot
oder Zielchat muss die gewünschte Behandlung vorhandener Meldungen manuell
geprüft werden; es findet keine automatische Migration oder erneute Zustellung
abgeschlossener Artikel statt.

Die neue `discovery`-Outbox ist vom bisherigen Vier-Konten-Zustand getrennt.
Test-/Echtzustand und Fixture-/BRACK-Zustand können nicht verwechselt werden.
Zustandsspeicherung und exklusive `run.lock` verwenden den vorhandenen `Store`
mit atomarem Umbenennen, Dateirechten 0600 und Synchronisierung. Die Sperre
umfasst Scan und gesamten Zustellablauf. Beschädigte Daten werden abgewiesen.
Verwaiste Sperren erst nach Prüfung, dass kein Prozess mehr läuft, manuell
entfernen. Kein automatisches Übernehmen einer möglicherweise aktiven Sperre.

Aufträge stehen unter `discovery.entries[Artikelnummer]` und enthalten den
Produktsnapshot, Nachrichtentext, Status, Versuche, Zeitstempel, einen sicheren
Fehlercode und nach Erfolg ausschliesslich die Telegram-Nachrichten-ID.

## Wiederholungen und unklare Zustellung

Der Ablauf ist `pending -> sending -> sent`. Vor jedem POST wird `sending`
dauerhaft gespeichert; nach bestätigtem Erfolg werden Status und Nachrichten-ID
gespeichert. Abgeschlossene Artikel werden bei Neustart nicht wiederholt.
Ein Speicherfehler nach einem erfolgreichen POST bricht den Lauf ab.

Bestätigte 429-Ablehnungen sowie eindeutig vor dem Senden gescheiterte Verbindungen
(DNS-Auflösung, Verbindungsablehnung, Verbindungsaufbau-Timeout) sind wiederholbar.
Die Outbox verwendet 30 Sekunden exponentiellen Backoff bis 30 Minuten plus
Jitter, maximal fünf Versuche über Neustarts hinweg. Telegram `retry_after` und
HTTP `Retry-After` können die Pause verlängern. Die Pause gilt für den gesamten
Chat, auch für neue Artikel und nach ausgeschöpften Versuchen eines Artikels.
Beim Einzelaufruf erfolgt ein fälliger Versuch je Artikel; weitere Versuche
erfolgen beim nächsten Aufruf oder im ausdrücklich aktivierten Watch-Modus.

Bestätigte 400/401/403/404-Ablehnungen bleiben `failed`. 401/403 und ungültige
Rate-Limit-Angaben stoppen den Watch-Modus. Nach Behebung der Ursache kann ein
bestätigt fehlgeschlagener Auftrag ausdrücklich erneut versucht werden:

```sh
npm run notify:brack -- --telegram --config config/telegram.local.json --retry-failed 100001
```

Telegram bietet für `sendMessage` keinen clientseitigen Idempotenzschlüssel.
Nach allgemeinem Timeout, Verbindungsabbruch, 5xx, ungültiger Antwort oder einem
Prozessabbruch während `sending` ist Erfolg möglicherweise bereits eingetreten.
Solche Aufträge werden **`uncertain`** und nicht automatisch erneut gesendet.
Damit wird keine unhaltbare Exactly-once-Garantie behauptet. Die Priorität liegt
auf dem Verhindern vermeidbarer Doppelmeldungen; eine tatsächlich ausgebliebene
Nachricht kann deshalb bis zur manuellen Klärung fehlen.

Unklare Aufträge im Zielchat manuell prüfen. Ist die Nachricht dort vorhanden,
kann der lokale Zustand ohne neue Zustellung bestätigt werden:

```sh
npm run notify:brack -- --telegram --config config/telegram.local.json --ack-uncertain 100001
```

`--retry-failed` akzeptiert keine unklaren Aufträge. Für sie gibt es keinen
automatischen oder unbestätigten Nachsende-Schalter. Bei nachweislich fehlender
Zustellung ist eine gesonderte manuelle Klärung notwendig. Zustand nicht einfach
löschen. Allgemeine Erreichbarkeitsfehler oder unklare Zustellung stoppen den
aktuellen Sendebatch; später neue Artikel können weiter bearbeitet werden,
während unklare Artikel angehalten bleiben. Bereits wartende sichere
Wiederholungen funktionieren auch bei einem späteren BRACK-Scanfehler.

## Erstbestand und Betrieb

Ein leerer neuer Zustand behandelt alle aktuell passenden Artikel als erstmals
erkannt. Wer beim späteren manuellen Start nur nachfolgend neue Artikel melden
möchte, kann vor der ersten erfolgreichen Erfassung ausdrücklich `--baseline`
verwenden. Der erste Bestand wird dann als `suppressed` gespeichert, ohne
Nachrichtenversand. Ein erneutes Baseline-Setzen wird abgewiesen. Die alten
VPS-Beobachtungen werden nicht gelesen oder migriert.

Logs enthalten Modus, Artikelnummern, Zähler und sichere Fehlercodes. Fehlende
Konfiguration, Zustands-/Scanfehler, Zustellfehler oder angehaltene Aufträge
führen beim Einzelaufruf zu Exitcode 1. Bei unklaren/fehlgeschlagenen Aufträgen
weist `held` auf den manuellen Klärungsbedarf hin. Alte Testvorschauen der
vier simulierten Warenkörbe bleiben unverändert und werden nie echt versendet.

Vor einer späteren Inbetriebnahme müssen lokale Zugangsdaten und Zielchat
bereitgestellt, eine einzelne echte Testmeldung bewusst geprüft und die
Erstbestandsstrategie gewählt werden. Diese Entwicklung führt das nicht aus.
Es gibt keinen Checkout, keine echten Warenkorbaktionen und kein Deployment.
