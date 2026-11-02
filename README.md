# BRACK Pokémon Monitor – Offline-Prototyp

## Aktueller Standard: genau vier simulierte Konten

`npm start` verwendet jetzt `runFourMonitor` mit `mock-account-1` bis
`mock-account-4`. Andere Konten, doppelte IDs und eine andere Anzahl werden
abgelehnt. Es existiert weiterhin kein Live-Modus.

Der gemeinsame Scanner läuft einmal je Aufruf. Die zentrale persistente
Warteschlange enthält genau einen Auftrag je Produkt und Konto. Englische
TCG-Produkte werden zuerst bearbeitet. Jedes Konto besitzt eine eigene simulierte
Sitzung, Warenkorbmengen, Fehlerstatus und chronologische Verarbeitungshistorie.
Loginfehler stoppen für diesen Lauf nur das betroffene Konto. Warenkorbfehler
bleiben am Auftrag; andere Konten und Produkte laufen weiter.

Der Zustand liegt separat in `data/four-accounts/state.json`. Der bisherige
Einzelkonto-Zustand bleibt unverändert und wird nicht automatisch migriert oder
nochmals als Vier-Konten-Zustand interpretiert. Die frühere Einzelkonto-Funktion
bleibt für bestehende Tests erhalten; die nachfolgenden allgemeinen Abschnitte
beschreiben teilweise diesen ursprünglichen Ablauf.

### Kontenübergreifende Mengenregeln

- `stock` ist im Vier-Konten-Modell der gemeinsam verfügbare Gesamtbestand.
- `globalLimit` ist ein verpflichtendes gemeinsames Limit für alle vier Konten
  pro Produkt. Es wird niemals mit der Kontenzahl multipliziert.
- `maxPerOrder` begrenzt jede einzelne Kontomenge. Optionale `accountLimits`
  können sie weiter reduzieren (Schlüssel sind die vier Konto-IDs).
- Zuteilung: zuerst Konto 1, dann 2, 3, 4; jedes bekommt die maximal verbleibende
  zulässige Menge. Das ist bewusst keine faire Gleichverteilung. Fehlgeschlagene
  Konten reservieren kein Budget; erfolgreiche spätere Konten können es nutzen.
- Bereits bestätigte Warenkorbmengen zählen auch bei einer fehlgeschlagenen
  Telegram-Simulation gegen das globale Budget. Ein Zustellversuch bereitet den
  Warenkorb nicht nochmals vor.
- Ohne Budget bleibt der Auftrag offen und wird beim nächsten Aufruf geprüft.
  `limited` ist eine Mengenbegrenzung, kein technischer Fehler.
- Unbekannte Limits werden abgelehnt. Bei nachträglich gesenkten Limits unter
  bereits vorbereitete Mengen werden weitere Aktionen für dieses Produkt
  blockiert und ein Fehler protokolliert. Bestehende Mengen werden nicht heimlich
  entfernt. Manuelle Klärung ist erforderlich.
- Vier-Konten-Warenkörbe beginnen leer. Das alte Fixture-Feld `existingQuantity`
  betrifft nur den alten Einzelkonto-Test; im neuen Ablauf stammen bestehende
  Mengen ausschliesslich aus dem jeweiligen gespeicherten Kontowarenkorb.

Die exklusive Zustandssperre umfasst Scan, Mengenvergabe und Adapteraufrufe.
Ein konkurrierender Lauf mit demselben Zustand wird vor dem Scan abgewiesen.
Für alle vier Konten muss derselbe Zustandspfad verwendet werden; getrennte
Projektkopien koordinieren ihre Limits nicht miteinander. Stabile Schlüssel pro
Produkt/Konto und Zielmengen statt additiver Wiederholungen bilden die Grundlage
für idempotente Verarbeitung. Die Mocks haben keine externen Seiteneffekte.

### Noch fehlende Schnittstellen für mehrere Konten

Die realen Regeln für kontoübergreifende Beschränkungen sind unbekannt. Hier gelten
ausschliesslich die expliziten Simulationswerte, ohne Umgehung gemeinsamer Limits.
Weitere Limits über Produktgruppen oder Zeiträume sind nicht implementiert.
Reale Sitzungen mit Ablauf/Erneuerung, sichere Geheimnisverwaltung, serverseitiger
Warenkorbabgleich und Zustellbestätigungen müssten gesondert entwickelt werden.
Bei Scanner-Ausfall nutzt ein Wiederanlauf zuletzt gespeicherte Mock-Daten;
für Live-Betrieb wären Aktualitätsgrenzen und erneute Mengenvalidierung nötig.

Tests: `npm test` führt beide Testdateien aus. Detaillierte TAP-Ausgabe ist mit
`node test/monitor.test.js` und `node test/four-monitor.test.js` verfügbar.

## Ursprünglicher Einzelkonto-Prototyp und allgemeine Hinweise

Eigenständiges Node.js-20-Projekt ohne Changedetection und ohne externe Pakete.
Alle Adapter sind Mocks: keine Netzwerkverbindungen, Logins, realen Warenkörbe,
Telegram-Nachrichten oder Bestellungen. Es gibt keinen produktiven Betriebsmodus.
Das Projekt installiert oder verändert keine Dienste oder Container.

## Lokal ausführen

Im Verzeichnis `brack-monitor`:

```sh
npm test
npm start
```

Der Start führt genau einen simulierten Scan aus. Wiederholte Starts verarbeiten
bereits abgeschlossene Produkt-IDs nicht erneut. `data/state.json` enthält den
Zustand und simulierte Ergebnisse. Logs sind JSON-Zeilen auf stdout; Fehler führen
zu Exitcode 1. Tests erzeugen und entfernen eigene Verzeichnisse im Projekt.
Keine Zugangsdaten konfigurieren; solche werden derzeit nicht verwendet.

## Fachliche Regeln

- Englisch, Marke `pokemon`, Kategorie `tcg`: Priorität 2.
- Deutsch, Marke `pokemon`, Serie `30-jahre-jubilaeum`: Priorität 1.
- Andere Produkte werden ignoriert. Klassifikation erfolgt über explizite
  normalisierte Felder, nicht über unzuverlässige Titel-Teilstrings.
- Neu bedeutet hier: erstmals beobachtete stabile Produkt-ID. Wiederverfügbarkeit
  oder Änderungen bereits abgeschlossener Produkte lösen keine neue Meldung aus.
- Mengenmodell der Simulation: `stock` ist der insgesamt für diesen Warenkorb
  verfügbare Bestand, `maxPerOrder` das Gesamtlimit pro Artikel, `existingQuantity`
  die bereits vorhandene Menge. Ziel ist das Minimum aus Bestand und Limit;
  hinzuzufügen ist die Differenz. Unbekannte oder ungültige Werte werden abgelehnt.
- Warenkorbvorbereitung ist nur ein gespeicherter Mengenplan, kein Bestellvorgang.
- Erst nach erfolgreicher Vorbereitung entsteht die simulierte Telegram-Meldung.

## Ablauf und Wiederanlauf

`MockScanner.scan()` liest ausschliesslich `fixtures/products.json`.
Neue Treffer werden vor Adapteraufrufen dauerhaft gespeichert. Der Ablauf lautet
`pending -> prepared -> done`. Fehler bleiben mit Versuchszähler und Fehlermeldung
erhalten. Beim nächsten manuellen Start werden sie erneut versucht. Aktualisierte
Scannerdaten ersetzen die Daten noch nicht vorbereiteter Produkte. Vorbereitete
Meldungen werden auch dann bearbeitet, wenn der Scanner fehlschlägt.

Eine exklusive Dateisperre verhindert parallele Läufe. Zustandsdateien werden über
eindeutige temporäre Dateien, Dateisynchronisierung und Umbenennen geschrieben.
Beschädigter Zustand wird nicht automatisch verworfen. Nach einem harten Abbruch
kann `data/run.lock` verbleiben: erst nach Prüfung, dass kein Lauf mehr aktiv ist,
manuell entfernen. Automatisches Übernehmen veralteter Sperren ist nicht enthalten.

Adapter erhalten stabile Idempotenzschlüssel. Die Mocks erzeugen deterministische
Referenzen ohne externe Seiteneffekte. Für reale Adapter wäre damit allein keine
Exactly-once-Garantie gegeben: Ein Abbruch nach externem Erfolg, aber vor lokaler
Speicherung kann Wiederholungen verursachen. Warenkorb muss deshalb einen Zielstand
abgleichen; Telegram benötigt eine gesonderte Zustellstrategie, da ein Schlüssel
allein keine Deduplizierung durch einen externen Dienst garantiert.

## Noch fehlende Schnittstellen und bewusste Grenzen

1. **BRACK-Scanner:** erlaubte Datenquelle, Schema, Paginierung, stabile IDs,
   Sprach-/Serienzuordnung und Bedeutung der Bestandsfelder klären. Keine reale
   URL oder API wurde vorausgesetzt. Echte Abrufe sind nicht implementiert.
2. **Warenkorb:** aktuelle serverseitige Mengenvalidierung, Kontolimits, vorhandene
   Positionen, Reservierung und Sitzung klären. Vor Verwendung eines alten Plans
   wäre erneute Validierung nötig. Ein reales Checkout-Modul ist nicht vorhanden.
3. **Telegram:** sichere Konfiguration, begrenzte Netzwerk-Timeouts, Wiederholungen,
   Backoff und Umgang mit unklaren Zustellergebnissen fehlen bewusst. Es wird nur
   das simulierte Nachrichtenergebnis gespeichert.
4. **Scheduling:** kein Timer, Hintergrundprozess oder automatischer Neustart.
   Wiederholungsversuche erfolgen ausschliesslich beim nächsten Aufruf.
5. **Betrieb:** keine Verfügbarkeitsalarme, Eskalationen, Retention oder Metriken;
   strukturierte Logs und Fehlerstatus bilden deren Grundlage. Adapter werden
   seriell ausgeführt; hängende reale Adapter würden eigene Abbruch-/Timeoutlogik
   benötigen. Warenkorbfehler verhindern bis zur erfolgreichen Wiederholung die
   Produktmeldung; eine separate Fehlermeldungs-Outbox wäre eine Erweiterung.
6. **Speicher:** für einen lokalen Prozess mit kleinen Datenmengen ausgelegt.
   Kein Schutz gegen bösartige Symlinks, kein Datenbank-Backend, keine Garantie
   bei Stromausfall (Verzeichnis wird nicht explizit synchronisiert). Der erlaubte
   Zustandspfad wird lexikalisch auf das Projekt begrenzt.

Vor einer echten Integration sind gesonderte Freigabe, Schnittstellenprüfung und
weitere Tests nötig. Es gibt hier keinen Schalter, der reale Adapter aktiviert.
