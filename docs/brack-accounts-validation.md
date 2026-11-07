# Validierung des Kontoadapters – 7. November 2026

## Automatisiert geprüft

Die **13 Kontotests** in `test/real-accounts.test.js` bestehen unter der lokal
verwendeten Node-24-Laufzeit. Ausführung: `node test/real-accounts.test.js`.
Die Gesamtprüfung des Repositorys erfolgt mit `npm test`; ihre aktuelle
Gesamtanzahl wird im Pull Request dokumentiert.

Die Kontotests prüfen:

- Genau vier getrennte Kontoplätze und Ablehnung doppelter oder vertauschter
  Kunden-/Warenkorbidentitäten.
- Privaten Vault ausserhalb Git, Dateirechte, Symlink-Abweisung
  und eine globale Sperre gegen parallele Anmeldung/Prüfung.
- Manuelles Enrolment mit injiziertem Browser, Identitätsprüfung vor Speicherung
  sowie keine Passwortoption oder Passwortdatei.
- Getrennte Cookie-Jars; ausschliesslich erlaubte Identitäts-/Warenkorb-GETs ohne
  automatische HTTP-Wiederholungen oder Weiterleitungen.
- Ablehnung ungeprüfter Verträge, fremder Ziele, Checkout-/Bestellpfade und
  nichtleerer Produkt-/Schreibverträge.
- Fehlende Schreibmethoden im Adapter und Ablehnung von `write: true` sowie
  `--write-approved`, auch mit einer vorhandenen synthetischen Freigabedatei.
- HTTP 429 als Pausensignal, 403/503/CAPTCHA als Stoppsignal und 401 als Fehler der
  einzelnen Sitzung; jeweils ohne erneute Anfrage.
- Ablehnung beschädigter oder öffentlich lesbarer lokaler Zustände und sicherer
  CLI-Abbruch ohne vertrauliche Werte im Log.
- Vier echte Playwright-APIRequestContexts mit synthetischen Cookie-Jars,
  vollständig ohne Netzwerkzugriff.

Der Vertrag in `test/helpers/accounts.js` und alle Konto-/Warenkorbdaten sind
synthetisch. Seine `/synthetic/...`-Pfade sind **keine BRACK-Endpunkte**. Diese
Tests bestätigen die lokale Schutzlogik, keine Kompatibilität einer echten API.
Automatische Warenkorbbefüllung und deren vorbereiteter Schreibpfad wurden aus
diesem Umfang entfernt; es gibt keine Mengenplanung oder Mutationstests für echte
Konten. Die bestehenden Mock-Betriebsarten bleiben davon unabhängig.

## Nicht live geprüft

Es wurden keine Zugangsdaten verwendet, keine echten Konten angemeldet und keine
authentifizierten BRACK-Anfragen ausgeführt. Ungeprüft bleiben insbesondere:

- Tatsächliche Login-/Cookie-Architektur, Identitäts- und Warenkorb-GETs.
- Antwortfelder, vollständiger Warenkorbnachweis und stabile Kontobindung.
- Sitzungsablauf/-rotation und Kompatibilität mit dem konkreten VPS.
- Privater Grafikzugang und manuelle Anmeldung auf dem VPS.

Das [Konfigurationsbeispiel](../config/brack-account-contract.example.json) bleibt
absichtlich unkonfiguriert und wird beim Start abgewiesen. Nur tatsächlich
beobachtete, lokal geprüfte Identitäts-/Warenkorb-GETs dürfen eingetragen werden.
Andere Transport- oder Antwortschemata benötigen zuerst eine gezielte Änderung
anhand bereinigter Belege; keine Pfade oder Vollständigkeitsfelder erraten.

Die [VPS-Anleitung](brack-accounts.md) beschreibt die spätere manuelle Anmeldung
und einmalige Leseprüfung. Der Verwaltungsaufruf startet keinen Scanner oder
Telegramversand. Es wurden keine VPS-Verbindung, Dienständerung, Bereitstellung,
Warenkorbänderung, Bestellung oder Zusammenführung ausgeführt.
