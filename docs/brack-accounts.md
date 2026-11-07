# Vier BRACK-Konten: manuelle Anmeldung und Leseprüfung

Stand: 7. November 2026. Echte BRACK-Sitzungen, Login und Warenkorb-Lesezugriffe
sind **noch nicht live verifiziert**. Automatische Warenkorbbefüllung,
Mengenplanung, Schreibadapter, Checkout und Bestellungen sind nicht implementiert.
Die 13 Kontotests verwenden synthetische Antworten und keine Zugangsdaten.

`npm run accounts:brack` ist ein ausdrücklicher Verwaltungsaufruf für genau vier
getrennte Sitzungen. Er startet weder Scanner noch Telegram noch eine Schleife.
Ohne `--login` führt er dieselbe einmalige Prüfung wie `--inspect` aus. Der
laufende Telegram-Dienst, WOG und ChangeDetection werden damit nicht verändert.

## Zuerst den tatsächlichen Lesevertrag prüfen

Das Beispiel [brack-account-contract.example.json](../config/brack-account-contract.example.json)
enthält absichtlich keine Endpunkte. Unverändert wird es abgewiesen. Ein Betreiber
muss in den Browser-Entwicklertools seiner eigenen normalen BRACK-Sitzung die
tatsächlichen authentifizierten JSON-GETs und deren Antworten prüfen:

| Vertragsfeld | Erforderlicher Nachweis |
| --- | --- |
| `identity.path` | Beobachteter GET für authentifizierte Kunden- und Warenkorbidentität; keine Gastkennung |
| `identity.subject`, `identity.cartId` | JSON-Pointer auf diese stabilen IDs |
| `cart.path` | Beobachteter GET für den vollständigen tatsächlichen Warenkorb |
| `cart.cartId`, `cart.items`, `cart.complete` | JSON-Pointer auf Warenkorb-ID, Positionsarray und serverseitigen Vollständigkeitsnachweis, der boolesch `true` sein muss |
| `cart.productId`, `cart.quantity` | Pointer relativ zu jeder Position: numerische Artikelnummer und positive sichere JSON-Ganzzahl als Gesamtmenge |

Andere Pointer beziehen sich auf die vollständige jeweilige Antwort. Identitäten
müssen Strings mit 1–200 Zeichen oder positive sichere Ganzzahlen sein. Doppelte
Artikelpositionen, abweichende Identitäten und unvollständige Antworten werden
abgewiesen. Leere Warenkörbe sind mit bestätigter Vollständigkeit zulässig.
Pfade sind ausschliesslich relative Pfade auf `https://www.brack.ch`, ohne
Queryparameter, Platzhalter oder Weiterleitungen. Checkout-/Bestellpfade sind gesperrt.

Erst nach tatsächlicher Prüfung `reviewed: true` und `reviewedAt` als ISO-Zeitpunkt
eintragen. `version` bleibt `1`, `origin` bleibt `https://www.brack.ch`. Nichtleere
`product`- oder `write`-Abschnitte werden abgewiesen. Eine lokale Freigabedatei
aktiviert nichts; `--write-approved` ist ungültig, der Adapter besitzt keine
Warenkorb-Schreibmethode. Keine Endpunkte, Vollständigkeitsfelder oder Limits erfinden.

Falls BRACK andere Domains, GraphQL-POSTs, Bearer-Header oder ein anderes Schema
benötigt, ist dieser Adapter noch nicht kompatibel. Dann anhand bereinigter
Schema-Beispiele weiterentwickeln. Keine HARs, Cookies oder Authorization-Daten
an GitHub übertragen und keine Schutzmechanismen abschalten.

## Spätere manuelle Einrichtung auf dem VPS

Diese Anleitung führt nichts aus und ist kein Deployment. Einen separaten
Review-Checkout mit Node 20+ unter einem unprivilegierten Benutzer verwenden;
den aktiven Checkout und produktive Dienste unverändert lassen.

1. Im Review-Checkout `npm ci` und für die manuelle Browseranmeldung
   `npx playwright install chromium` ausführen. Systembibliotheken müssen vorhanden
   sein. Einen privaten grafischen Desktop mit interaktivem Terminal bereitstellen;
   keine öffentlichen Browser-/DevTools-Ports und keine deaktivierte TLS-Prüfung.
2. Einen privaten Vault **ausserhalb des Repositorys** erstellen, beispielsweise:

   ```sh
   umask 077
   export BRACK_ACCOUNT_VAULT="$HOME/.local/share/brack-monitor-accounts"
   install -d -m 0700 "$BRACK_ACCOUNT_VAULT"
   cp config/brack-account-contract.example.json "$BRACK_ACCOUNT_VAULT/contract.json"
   chmod 0600 "$BRACK_ACCOUNT_VAULT/contract.json"
   ```

3. Nur lokal `contract.json` anhand der geprüften Lesezugriffe ergänzen. Keine
   Passwörter oder Cookies in Vertrag, Kommandozeile oder Umgebungsvariablen schreiben.
4. Die vier Konten nacheinander mit frischem Browserkontext anmelden:

   ```sh
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-1
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-2
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-3
   npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --login brack-account-4
   ```

   Nur im offiziellen Formular anmelden, ohne Warenkorbänderung oder Bestellung.
   Danach am Terminal `angemeldet` bestätigen. Bei CAPTCHA/Zugriffsschutz abbrechen.
   Identitätsprüfung verhindert doppelte Konten und vertauschte Sitzungen. Eine
   abgelaufene Sitzung desselben Kontos mit demselben Loginbefehl erneuern.
5. Einmalig `npm run accounts:brack -- --vault "$BRACK_ACCOUNT_VAULT" --inspect`
   ausführen und die vier Warenkörbe im normalen Browser vergleichen. Logs enthalten
   Kontoalias, Prüfzeit, Positionsanzahl und `writes: false`, keine Cookie-/Produktdaten.

Jedes Konto hat eine eigene `session.json` und `binding.json` im Unterverzeichnis
`brack-account-1` bis `brack-account-4`. Bindungen enthalten nur SHA-256-Hashes;
Sitzungen enthalten BRACK-Cookies und eventuell LocalStorage und sind wie
Zugangsdaten zu schützen. Dateien benötigen `0600`, Verzeichnisse `0700`, korrekten
Eigentümer und dürfen keine Symlinks sein. Auch Sicherungen bleiben ausserhalb Git.

Eine Vault-Sperre verhindert parallele Anmeldung/Prüfung. Nach Absturz `accounts.lock`
nur entfernen, wenn sicher kein Prozess läuft. Es gibt keine automatischen HTTP-
Wiederholungen oder Weiterleitungen. 401/Identitätsfehler betreffen das einzelne
Konto; 429 beendet den Prüflauf bis zur erforderlichen Pause, 403/503/CAPTCHA stoppen
ihn. Die CLI wiederholt nichts automatisch. Sitzungsrotation, tatsächliche BRACK-
Schemas, VPS-Grafikzugang und langfristige Authentifizierung bleiben live ungeprüft.
