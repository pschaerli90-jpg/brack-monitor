# Telegram: Pokémon EN/DE/FR mit BRACK-Produktbild

Der vorhandene BrackScanner liest die öffentliche Sammelkartenliste. Die
Benachrichtigungs-Outbox wählt Pokémon in Englisch, Deutsch und Französisch aus,
ohne Sprachpriorität und ohne Beschränkung auf eine deutsche Serie. Andere
Marken sowie unbekannte/mehrdeutige Sprachen bleiben ausgeschlossen.

## Inhalt und Bilder

Eine neue Artikelnummer erzeugt einen gespeicherten Auftrag. Telegram erhält
sendPhoto mit dem echten MAIN-Bild aus den öffentlichen BRACK-Listendaten und
folgendem Bildtext:

~~~text
Neues BRACK Pokémon-Produkt
Produkt: Beispielprodukt
Artikelnummer: 100001
Sprache: Französisch (FR)
Lagerbestand (bei Erkennung): 12
Link: https://www.brack.ch/beispielprodukt-100001
~~~

Die Bildadresse wird aus images[].sizes[].src übernommen, nicht aus der
Artikelnummer konstruiert. Verifiziertes Asset-Schema: HTTPS auf assets.brack.ch
unter /images2/. Fremde Hosts,
Benutzerinformationen und unsichere URLs werden nicht als Ersatz verwendet.
Telegram lädt diese öffentliche URL selbst. Es gibt keinen lokalen Cookiezugriff
für Bilder. Ein fehlendes Bild hält den Auftrag ohne Versandversuch zurück;
spätere Scans können das echte Bild ergänzen. Keine Platzhalter und kein
zusätzlicher Textversand bei unklarem Fotoergebnis.

Name, Bestand und erste Erkennung stammen aus dem ursprünglichen Snapshot.
Die Erkennungszeit wird intern als firstSeenAt und im Erkennungslog gespeichert,
nicht in Telegram angezeigt. Sehr lange Namen werden mit Ellipse gekürzt, damit
Bildtext samt allen übrigen Feldern in 1024 Zeichen passt; der vollständige Name
bleibt intern gespeichert. Ein späterer Retry behauptet keinen aktuellen Bestand.

## Start und sichere Konfiguration

~~~sh
npm run notify:brack -- --test --fixture fixtures/brack-listing.html
npm run notify:brack -- --test --watch --interval-seconds 30
~~~

Der Testmodus liest keine Telegram-Zugangsdaten. Fixtures sind ausschliesslich in
diesem Modus erlaubt. Echter Versand benötigt --telegram sowie entweder eine
private lokale Datei mit botToken/chatId oder das vollständige lokale Paar
TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID. Keine Token in CLI-Argumenten oder Git.
Die Datei muss eine eigene reguläre Datei mit 0600 sein; Symlinks werden abgewiesen.
Nicht mehrere Konfigurationsquellen mischen.

~~~sh
npm run notify:brack -- --telegram --config /privater/pfad/telegram.local.json --watch --interval-seconds 30
~~~

Das ist eine Anleitung für eine spätere bewusste Inbetriebnahme. Es wird kein
Hintergrunddienst installiert und kein laufender Dienst verändert. Lokaler
Standardzustand für echten Versand: data/telegram-discovery; für Testversand:
data/telegram-discovery-test; Fixtures: data/telegram-discovery-fixture.
Ein bestehender --state-dir-Pfad muss bei der Umstellung beibehalten werden.

Der Standard im Watch-Modus ist 30 Sekunden Pause nach abgeschlossenem Lauf.
Kürzere Intervalle werden abgewiesen. Neue Meldungen werden vor dieser Pause
verarbeitet. SIGINT/SIGTERM beenden nach dem laufenden begrenzten Aufruf.
BRACK-Retry-After kann länger pausieren; CAPTCHA/Zugriffsschutz stoppt den Scan.

## Migration und Deduplizierung

Vor Umstellung lokalen Zustand sichern. **Keine neue Outbox anlegen und keine
Einträge löschen**, um eine Migration zu erzwingen. Zustände Version 1 werden
unter der existierenden Dateisperre validiert und auf Version 2 umgestellt.
Gesendete und unterdrückte Artikel bleiben erledigt; unklare/fehlgeschlagene
Zustellungen behalten ihren Status, ebenso Quittungen, Versuchszähler und
Zeitstempel. Alte Nachrichtentexte bleiben nur als interne Migrationshistorie.

Version 1 speicherte keine Beobachtungen ausgeschlossener DE-/FR-Produkte. Darum
bildet der erste vollständige Scan nach der Migration eine konservative Baseline
für alle bisher nicht gespeicherten Artikel. Auch neu passende FR- oder normale
DE-Bestandsartikel werden dabei nicht nachgemeldet. Gerade zwischen den Versionen
neu erschienene Artikel können ebenfalls in diese Baseline fallen. Ohne einen
vollständigen Scan bleibt sie offen. Erst danach melden spätere Scans neue IDs.

Version 2 speichert alle beobachteten IDs. Eine spätere Änderung von Titel,
Sprache oder Auswahl erzeugt keinen zweiten Auftrag. Ein neuer Zustand meldet
standardmässig den ersten passenden Bestand; --baseline unterdrückt ihn bewusst.
Eine bestehende Version-1-Outbox benötigt --baseline nicht nochmals. Ohne erhaltene
Zustandsdateien ist eine Garantie gegen erneute Bestandsmeldungen nicht möglich.

## Zustellschutz

Die exklusive Store-Sperre umfasst den ganzen Lauf. Vor dem einzigen POST pro
Versuch wird sending dauerhaft gespeichert. Erfolgreiche Antworten werden anhand
der Empfängeridentität und Nachrichten-ID verifiziert. Ein Absturz oder Timeout
kann zu uncertain führen; dann wird nicht automatisch nachgesendet. Kein
Exactly-once-Versprechen für Telegram.

Bestätigte Nichtzustellung kann mit Backoff/Jitter begrenzt wiederholt werden.
HTTP 429 speichert eine globale Telegram-Pause, auch über Neustarts hinweg.
Die BRACK-Erkennung läuft während einer reinen Telegram-Pause weiter. 401/403
stoppen die Zustellung. Fehler enthalten keine Tokens, Chat-IDs oder Rohantworten.

--retry-failed ARTIKEL ist nur für bestätigte fehlgeschlagene Zustellung zulässig.
--ack-uncertain ARTIKEL bestätigt eine zuvor manuell im Chat geprüfte unklare
Zustellung ohne neuen POST. Beide Aktionen sind nicht kombinierbar. Test/Echtbetrieb,
Quellen oder alte Mock-Warenkorbzustände dürfen nicht vermischt werden.
Beschädigte Dateien und bestehende run.lock-Sperren werden nicht automatisch
zurückgesetzt; Sperren erst nach Prozessprüfung manuell entfernen.

Die Produktmeldung lädt keine Kontositzung und löst keinerlei Warenkorbaktion aus.
WOG, ChangeDetection und vorhandene VPS-Prozesse werden nicht angesprochen.
