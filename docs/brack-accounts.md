# Vier echte BRACK-Konten: zunächst Anmeldung und Lesetest

Stand: 4. November 2026. Diese Erweiterung ist **keine live bestätigte
BRACK-Warenkorbintegration**. Es wurden keine echten Sitzungen bereitgestellt,
keine vier realen Konten angemeldet und keine BRACK-Warenkörbe gelesen oder
verändert. Der direkte öffentliche Abruf aus der Entwicklungsumgebung lieferte
HTTP 503; es wurden keine Umgehungsversuche unternommen.

Der Adapter und der freigabegeschützte Warenkorbablauf sind implementiert und mit
synthetischen Antworten getestet. Tatsächliche authentifizierte BRACK-Endpunkte,
Antwortfelder, Limits und bedingte Schreiboperationen sind noch unbekannt.
Deshalb enthält das Konfigurationsbeispiel **keine erfundenen Endpunkte oder
Mengenwerte** und verweigert unverändert jeden Betrieb. Die synthetischen
/synthetic/...-Pfade aus Tests sind keine BRACK-Schnittstellen.

## Architektur und unveränderte Dienste

Der neue ausdrückliche Einstieg "npm run accounts:brack" verwendet weiterhin:

1. Den bestehenden BrackScanner für dieselbe öffentliche, paginierte Liste.
2. runFourMonitor, das nur für den echten Adapter den Kontopfad auswählt.
3. Die vorhandene runDiscoveryMonitor-Outbox. Ein optionaler Warenkorbprozessor
   läuft innerhalb derselben exklusiven Zustandssperre.
4. Dieselbe Produktmeldung, ergänzt um vier Kontoergebnisse. Erst nach dem
   gesamten Lauf beginnt die Intervallpause. Neue passende Artikel warten
   vor der Kontoauswertung nicht nochmals 30 Sekunden.
5. runLoop mit konfigurierbaren Intervallen ab 30 Sekunden, Standard 60 Sekunden.

Englischsprachiges Pokémon-TCG wird vor deutschem «30 Jahre Jubiläum» verarbeitet;
andere Produkte werden ignoriert. Die bestehende Klassifikation bleibt erhalten.

Die Aufrufe npm start, scan:brack, monitor:brack und notify:brack behalten ihr
Verhalten. Die bestehende Telegram-CLI lädt weder Sitzungen noch Playwright und
aktiviert den Warenkorbprozessor nicht. Ohne Kontoprozessor bleibt der bisherige
Produktmeldungstext unverändert. Die bisherigen vier Konten bleiben Simulationen.

Es werden weder systemd-/Docker-Konfigurationen noch VPS-Dateien, WOG oder
ChangeDetection verändert. Diese Anleitung führt nichts aus. Den neuen
Watch-Modus nicht zusätzlich zum laufenden Dienst als zweiten Produktivmonitor
starten. Eine spätere Umstellung des Startbefehls benötigt eine eigene
Betriebsfreigabe und ist nicht Teil dieses PR.

## Voraussetzung: lokal geprüfter Schnittstellenvertrag

Der Adapter unterstützt authentifizierte JSON-GETs auf https://www.brack.ch,
keine geratenen APIs und keinen ausführbaren Konfigurationscode. Die Anmeldung
erfolgt manuell im normalen BRACK-Browser. Pro Konto wird danach eine eigene
Playwright-Cookie-Jar geladen. Es gibt keinen automatischen Passwortlogin, keine
MFA-/CAPTCHA-Lösung und keine automatische Neuanmeldung nach Sitzungsablauf.

Ein Betreiber muss zuerst mit seinem eigenen normalen BRACK-Konto und den
Browser-Entwicklertools die tatsächlich verwendeten Lesezugriffe prüfen:

- Welcher **GET** liefert eine stabile authentifizierte Kundenidentität und die
  zugeordnete Warenkorbidentität? Eine Gastkennung genügt nicht.
- Welcher **GET** liefert den vollständigen aktuellen Warenkorb mit Artikel-IDs
  und Gesamtmengen? Teilseiten und Mini-Warenkörbe genügen nicht.
- Welches serverseitige Feld bestätigt dessen Vollständigkeit? Der Adapter
  fordert ein tatsächliches boolesches true, keine lokale Vorgabe.

Diese beobachteten Pfade und JSON-Pointer werden **nur lokal** in contract.json
eingetragen. Im cart-Abschnitt sind productId und quantity relativ zu jeder Zeile
des Arrays unter items; alle anderen Pointer beziehen sich auf die vollständige
jeweilige JSON-Antwort. Konto-/Warenkorb-IDs müssen nichtleere Strings oder positive
sichere Ganzzahlen sein, Mengen sichere JSON-Ganzzahlen. Doppelte oder
mehrdeutige Positionen werden abgewiesen.

Erst nach tatsächlicher Prüfung reviewed auf true und reviewedAt auf den lokalen
ISO-Prüfzeitpunkt setzen. Für Anmeldung und --inspect dürfen product,
limitSemantics und write zunächst null bleiben. Dann funktionieren keine
Mengenplanung und keine Warenkorbänderungen.

Falls BRACK hierfür nur GraphQL-POSTs, Bearer-Header, andere Domains, fehlende
Vollständigkeitsnachweise oder andere Schemata verwendet, ist der Transport
noch **nicht kompatibel**. Keine Semantik erraten und keine Sperre abschalten:
anhand bereinigter Schema-Beispiele muss der Adapter zunächst gezielt erweitert
und geprüft werden. Keine HARs/Netzwerkexporte mit Cookies oder Authorization
an GitHub senden.

### Verbindliche Mengenregeln

product kann erst nach Prüfung eines tatsächlichen authentifizierten Produkt-/
Limit-GETs konfiguriert werden. Benötigt werden path mit dem Platzhalter
{productId} sowie JSON-Pointer für:

| Feld | Verbindliche Bedeutung |
| --- | --- |
| productId | Bestätigte angefragte Artikelnummer |
| stock | Aktueller gemeinsamer Gesamtbestand einschliesslich der betrachteten Warenkorbpositionen |
| maxPerOrder | Verbindliche Obergrenze der Gesamtmenge je Warenkorb |
| accountLimit | Nach früheren Käufen verbleibende Kontoobergrenze einschliesslich der vorhandenen Warenkorbmenge |
| globalLimit | Gemeinsame Gesamtobergrenze über alle vier Konten einschliesslich vorhandener Warenkorbpositionen |
| limitsComplete | Serverseitig bestätigte Vollständigkeit aller einschlägigen Beschränkungen, boolesch true |

Erst wenn genau diese Semantik belegt ist, darf limitSemantics den Wert
"total-including-all-four-carts" erhalten. Auch Haushalts-, Produktgruppen-,
Kunden- und Zeitraumregeln müssen darin berücksichtigt sein. Vier Konten sind
keine Erlaubnis, gemeinsame Beschränkungen zu vervierfachen.

Ein Eingabefeld-max, Listenbestand, simulierte limits.example.json, fehlendes
Limit oder eine frei gewählte hohe Zahl reichen nicht. Wenn BRACK diese Daten
nicht belastbar bereitstellt, **bleibt automatisches Befüllen gesperrt**.

Die Planung berücksichtigt die tatsächlichen Positionen aller vier Warenkörbe.
Zuwachs ist höchstens der kleinere Wert aus persönlichem und gemeinsamem
Restbudget. Der Lesetest verteilt auch seine Vorschläge kontenübergreifend.
Scheitert ein Konto, bleiben die anderen einzeln lesbar; gemeinsames Mengenbudget
wird ohne vollständige Daten nicht für Schreibaktionen verwendet. Daten älter als
60 Sekunden sperren die Aktion. Mock-Limits werden niemals übernommen.

## Späterer sicherer VPS-Test

Die Schritte sind für einen späteren manuellen Review gedacht, kein Deployment.
Den aktiven Checkout und dessen Datenverzeichnis nicht verändern.

1. Einen separaten Review-Checkout des Branches unter einem eigenen
   unprivilegierten Benutzer anlegen. Node 20+ verwenden.
2. Dort npm ci ausführen. Playwright ist eine optionale, exakt versionierte
   Abhängigkeit; bisherige Befehle benötigen sie nicht. Für die Browseranmeldung
   zusätzlich npx playwright install chromium ausführen. Erforderliche
   Systembibliotheken vorher administrativ bereitstellen.
3. Ein **absolutes Verzeichnis ausserhalb des Git-Repositorys** wählen,
   ausschliesslich im Besitz des Testbenutzers. Beispiel bei entsprechenden
   Schreibrechten:

   ~~~sh
   umask 077
   export BRACK_ACCOUNT_VAULT=/var/lib/brack-monitor-accounts
   install -d -m 0700 "$BRACK_ACCOUNT_VAULT"
   cp config/brack-account-contract.example.json "$BRACK_ACCOUNT_VAULT/contract.json"
   chmod 0600 "$BRACK_ACCOUNT_VAULT/contract.json"
   ~~~

4. Den lokalen Vertrag wie oben beschrieben prüfen und mit einem lokalen Editor
   eintragen. Keine Passwörter/Cookies hineinschreiben. write bleibt beim ersten
   Test null; keine write-approval.json anlegen.
5. Einen privaten grafischen Browserzugang bereitstellen, etwa über SSH mit
   Grafikweiterleitung oder einen ausschliesslich über SSH erreichbaren Desktop.
   Keine öffentlichen VNC-/DevTools-Ports und keine abgeschaltete TLS-/Browser-
   Sicherheit. Ohne grafischen Zugang ist die manuelle Anmeldung auf dem VPS
   noch nicht ausführbar.
6. Die vier Konten **nacheinander** anmelden:

   ~~~sh
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-1
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-2
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-3
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-4
   ~~~

   Jeder Aufruf öffnet einen frischen isolierten Browserkontext. Nur im offiziellen
   BRACK-Formular anmelden, ohne Warenkorbänderung oder Bestellung. Danach am
   Terminal "angemeldet" bestätigen. Bei Zugriffsschutz abbrechen.
   Passwörter/MFA nie in Kommandozeilen, Umgebungsvariablen oder Skripte schreiben.

   Vor Speicherung wird die reale Identität geprüft. Doppelte Kunden- oder
   Warenkorbidentitäten sowie ein anderes Konto an einem schon gebundenen Platz
   werden abgewiesen. Eine abgelaufene Sitzung desselben Kontos kann mit demselben
   Loginbefehl erneuert werden.
7. Zuerst ausschliesslich die vier Sitzungen und Warenkörbe prüfen:

   ~~~sh
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --inspect
   ~~~

   Das führt **keinen öffentlichen Produktscan**, keinen Telegramversand und keine
   schreibende Warenkorbanfrage aus. Logs enthalten nur Kontoalias, Prüfzeit und
   Positionsanzahl. Im normalen Browser die tatsächlichen Warenkörbe vergleichen.
8. Nach vollständiger Schnittstellen-/Limitprüfung einmalig integriert lesen:

   ~~~sh
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT"
   ~~~

   Dieser Aufruf nutzt den bestehenden Scanner. Telegram bleibt standardmässig
   simuliert. Ergebnisse müssen "nur gelesen, keine Änderung" ausweisen.
   Unbekannte Limits führen korrekt zu gesperrten Plänen. Dieser Modus bleibt
   auch mit vorhandener Freigabedatei nicht schreibend.

Sitzungen liegen getrennt unter brack-account-1/session.json bis
brack-account-4/session.json. binding.json enthält nur SHA-256-Bindungen der echten
Konto-/Warenkorbidentitäten. Dateien erhalten 0600, Verzeichnisse 0700. Fremde
Eigentümer, offene Rechte und Symlinks werden abgewiesen.

Sitzungsdateien enthalten Cookies und eventuell BRACK-LocalStorage und sind wie
Zugangsdaten zu behandeln. API-Zugriffe verwenden Cookies; nur über LocalStorage-
Bearer-Tokens funktionierende APIs werden nicht automatisch unterstützt.
Passwörter werden nicht absichtlich gespeichert. Es werden keine Browserprofile,
HARs, Screenshots, Konsolenmitschnitte oder Traces exportiert.

Falls die Anmeldung auf einem getrennten lokalen Review-Rechner erfolgt, den
privaten Vault ausschliesslich verschlüsselt über SSH übertragen und auf dem VPS
Besitz/Rechte erneut prüfen. IP-/Gerätebindung oder Ablauf können eine erneute
manuelle Anmeldung auf dem VPS verlangen; Einschränkungen werden nicht umgangen.
Vault, Sicherungen und Laufzustände niemals an GitHub anhängen.

## Schreibpfad: implementiert, gesondert gesperrt

Schreiben ist in diesem PR **nicht freigegeben**. Es wurde keine echte
Freigabedatei erzeugt. Synthetische Testfreigaben sind keine Betriebsartefakte.

Vor einer späteren ausdrücklichen Schreibfreigabe müssen echte Lesetests,
vollständige Limits und der folgende BRACK-Schreibvertrag bestätigt sein:

- write.path ist ein tatsächlich beobachteter gleichursprünglicher Pfad mit
  {productId}; keine Checkout-/Bestell-/Zahlungsfunktion.
- method ist PUT, semantics ist "set-total": genau eine absolute Gesamtzielmenge
  unter dem beobachteten quantityField. Keine inkrementellen Add-Aufrufe.
- precondition ist "If-Match": BRACK prüft die starke Warenkorb-ETag aus dem GET
  wirklich atomar. Ein lokal gesetzter Header allein beweist dies nicht.
- csrfCookie und csrfHeader entsprechen dem tatsächlich verwendeten Verfahren.
- BRACK setzt Mengen-/Berechtigungsregeln auch beim PUT selbst durch.
  Lokale Dateisperren verhindern keine Änderungen anderer Clients. Während des
  freigegebenen Laufs keine manuellen Warenkorbänderungen vornehmen.

Eine nicht passende BRACK-Schreibschnittstelle bleibt inkompatibel.

Die spätere lokale write-approval.json muss version: 1, approved: true,
operation: "fill-carts-only", einen höchstens 24 Stunden in der Zukunft liegenden
ISO-Zeitstempel expiresAt, contractSha256 als SHA-256 von
JSON.stringify(validateContract(contract)) sowie bindings mit genau den vier
lokalen {subject, cart}-Hashpaaren enthalten. Bindungen werden in der Reihenfolge
brack-account-1 bis -4, jeweils subject vor cart, serialisiert.
Diese Werte nur lokal ableiten; es gibt keinen automatischen Freigabegenerator.

Erst **nach separater Freigabe** kann der Betreiber --write-approved zusätzlich
angeben. Das Flag allein reicht nicht. Die Freigabedatei wird vor jedem PUT erneut
geprüft. Ablauf, Widerruf, andere Bindungen oder anderer Vertrag sperren weitere
Mutationen. Der erste Lauf eines neuen Schreibzustands bildet automatisch eine
Baseline des vorhandenen Katalogs und befüllt keine historischen Artikel.
Danach werden nur neu entdeckte Artikel verarbeitet.

Lesetest und Schreiben haben getrennte Zustände read-test-state und write-state
innerhalb desselben privaten Vaults. Eine Lesetest-Vorschau wird niemals als
Befüllungsnachweis übernommen. Auch Telegram-Test und echte Zustellung werden
nicht in einem bestehenden Zustand vermischt. Eine solche Umstellung braucht
eine bewusst geprüfte Zustandsmigration; der Adapter führt sie nicht automatisch
aus. Echter Telegramversand benötigt zusätzlich --telegram und eine private
--config-Datei gemäss bestehender Telegram-Anleitung. Die Konfiguration und der
Zustand des laufenden Dienstes werden nicht übernommen.

## Verifikation, Fehler und Wiederanlauf

- Eine Vault-Sperre umfasst den gesamten neuen Prozess, zusätzlich zur Store-
  Sperre pro vollständigem Lauf. Login, Scan und Warenkorbprozesse desselben
  Vaults überlappen nicht. Den Vault nicht auf mehrere Hosts kopieren und
  gleichzeitig betreiben.
- Vor jeder Mutation werden alle vier tatsächlichen Warenkörbe erneut gelesen.
  Pro Artikel/Konto ist höchstens ein PUT zulässig; der Zielwert wird vorher
  dauerhaft als "mutating" gespeichert.
- Danach wird der vollständige echte Warenkorb erneut gelesen. Identität,
  Zielmenge und alle anderen Positionen müssen stimmen. Eine HTTP-Erfolgsantwort
  allein ist kein Befüllungsnachweis.
- Ein mehrdeutiger PUT bekommt einen lesenden Abgleich, keinen zweiten PUT.
  Bei Zugriffsschutz, Sitzungsfehlern oder HTTP 429 entfällt dieser Zusatzabruf.
  Nach Absturz vor Ergebnisspeicherung gleicht ein späterer Lauf einen auf Disk
  verbliebenen "mutating"-Auftrag nur lesend ab.
- "verified" bestätigt den gelesenen Warenkorb zum Prüfzeitpunkt. Nach einem
  Netzwerkfehler wird nicht behauptet, welcher Client die Änderung verursacht hat.
  Abweichende/nicht lesbare Ergebnisse bleiben "uncertain"; weitere gemeinsame
  Mengenplanung für diesen Artikel stoppt.
- 401/Identitätsfehler sperren das betroffene Konto. Die anderen werden unabhängig
  gelesen. Fehlgeschlagene Aufträge werden nicht bei jedem Scan erneut versucht;
  Re-Login entsperrt alte Aufträge nicht automatisch.
- HTTP 429 pausiert persistent mindestens gemäss Retry-After. 403, 503 und
  erkannte CAPTCHA-/Challenge-Antworten stoppen den Kontobetrieb. Neustart hebt
  eine gespeicherte Zugriffssperre nicht auf. Keine Schutzmechanismen umgehen.
- Telegram behält Outbox, Backoff und Behandlung unklarer Zustellungen. Telegram-
  Pausen blockieren keine neuen Warenkorbprüfungen. Während BRACK-Kontopausen
  bleiben neue Meldungen bis zur Kontoauswertung vorgemerkt. Telegram-Fehler
  wiederholen keine Warenkorbmutationen.
- Meldungen unterscheiden gelesene Mengen/Vorschläge, geprüfte Warenkörbe,
  gesperrte Konten und unklare Ausgänge. Es gibt keine Bestellbestätigung.

Nach Absturz zuerst beide Prozess-/Dateisperren prüfen. accounts.lock und run.lock
nur manuell entfernen, wenn sicher kein Prozess mehr läuft. Zustand nicht
löschen, um Schreibaufträge erneut auszulösen. Nach Ende einer Schutzpause mit
--inspect die tatsächlichen Konten vergleichen und Ergebnisse lokal klären.

Es gibt bewusst keinen automatischen Reset, keinen Retry-failed-Schalter für
Schreibaufträge und keine automatische Aufhebung von Kontosperren. Bewusstes
Wiederaufnehmen alter blockierter Aufträge braucht eine weitere geprüfte
Erweiterung; der vorliegende Stand verspricht diese Funktion nicht.

## Noch nicht live verifiziert

- Tatsächliche BRACK-Login-/Cookie-/Identitätsarchitektur.
- Vollständiges Warenkorbschema, dauerhafte Warenkorb-ID und Sitzungsrotation.
- Verfügbarkeit und Semantik aller Mengen-/Gemeinschaftslimits.
- Absoluter PUT, starke ETag/If-Match-Atomarität und CSRF.
- Reale Bestandsänderungen und Warenkorbverifikation.
- Echte kombinierte Telegramzustellung der vier Ergebnisse.
- Anmeldung auf dem konkreten VPS, Proxy-/Grafikbedarf und langfristiger Betrieb.

Ohne diese Prüfungen darf der Schreibpfad nicht als einsatzfähige automatische
Befüllung von vier echten BRACK-Warenkörben dargestellt werden.
Checkout, Bestellungen und automatische Bereitstellung sind nicht implementiert.
