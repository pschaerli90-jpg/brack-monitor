# Validierung des Kontoadapters – 4. November 2026

Ausgangsstand: main bei d2be44f5dcfbdea32013b00546dcac626d7468e4
(zusammengeführter PR #3). Branch: feat/four-account-session-cart.

## Automatisiert geprüft

Alle **111 Einzeltests** bestehen unter Node 20, 22 und 24 ohne übersprungene
Tests. Die 84 bisherigen Tests bleiben erhalten; hinzu kommen 12 Konto-/Sitzungs-
und 15 Warenkorb-/Integrationsfälle. Elf Testdateien insgesamt.

- Node 24: npm test.
- Node 20 und 22: vollständiger identischer Testsatz über node --test.
- git diff --check erfolgreich.
- Die installierte optionale Playwright-Laufzeit wurde mit vier separaten
  APIRequestContexts und synthetischen Cookie-Jars ohne Netzwerk geprüft.
- Die GitHub-Actions-Matrix bleibt bei Node 20/22/24; npm ci wurde für die
  versionierte optionale Abhängigkeit ergänzt.

Die neuen Tests decken ab:

- Genau vier Konten, Identitäts-/Warenkorbbindung, doppelte und vertauschte
  Sitzungen, Eigentum/Dateirechte, Symlink-Abweisung und externer privater Vault.
- Interaktives Enrolment mit injiziertem Browser und Identitätsprüfung; keine
  Passwörter in Dateien oder CLI-Optionen. Unkonfigurierte CLI verweigert Start.
- Getrennte Cookie-Jars, ausschliesslich GET im Lesemodus, keine automatischen
  HTTP-Retries/Weiterleitungen, fehlende oder widerrufene Schreibfreigabe.
- Unbekannte/überschrittene Limits, Bestand null, vorhandene Positionen aller
  Konten, gemeinsame Budgets sowie englische Priorität vor deutschem Jubiläum.
- Gemeinsamer Scanner und Outbox: Kontoauswertung und Nachricht vor der nächsten
  30-Sekunden-Pause; reine Leseresultate werden nicht als Befüllung ausgegeben.
- Absolute Zielmengen mit synthetischem CSRF und If-Match; tatsächlicher
  vollständiger GET-Abgleich nach PUT, unveränderte sonstige Warenkorbpositionen.
- Kontoausfall und unabhängige Leseprüfung anderer Konten, persistente 429-Pausen,
  Vormerkung neuer Artikel während Schutzpausen, Stopps bei 403/503/CAPTCHA.
- Telegram-Retries und wiederholte Scans ohne erneute Warenkorbmutation.
- Unklarer PUT, GET-Abgleich, abweichende Warenkörbe, Speicherfehler vor/nach
  Mutation und Absturzfenster; höchstens ein PUT pro Artikel/Konto.
- Baseline ohne Aktionen, Betriebszustandswechsel sowie fehlendes/null Ledger:
  kein automatisches Zurücksetzen einer bereits begonnenen Verarbeitung.

Alle Produkt-/Konto-/Warenkorbdaten der neuen Tests sind synthetisch. Insbesondere
ist der Testvertrag unter test/helpers/accounts.js kein beobachtetes BRACK-Schema.
Die erfolgreiche Prüfung zeigt die Sicherheits- und Ablauflogik, nicht die
Kompatibilität einer unbekannten echten BRACK-API.

## Nicht live geprüft / Betriebsblocker

Es gab keine echten Kontositzungen, keine Anmeldung mit BRACK-Zugangsdaten, keine
authentifizierten BRACK-Lesezugriffe, keine BRACK-Warenkorbmutation und keine
echte kombinierte Telegramzustellung. Ein direkter öffentlicher Abruf lieferte
503; Schutzmechanismen wurden nicht umgangen.

Die tatsächlichen Endpunkte, Vollständigkeits-/Limitfelder und Schreibsemantik
müssen lokal geprüft werden. Das Beispiel bleibt unkonfiguriert und startet nicht.
Falls BRACK die vorausgesetzten JSON-GETs, Mengenregeln, absolutes PUT oder
atomaren If-Match-Abgleich nicht unterstützt, muss der Adapter anhand sicher
bereinigter Belege erweitert werden. Diese Funktionen sind ohne jene Nachweise
nicht als produktionsbereit freigegeben.

Die [VPS-Anleitung](brack-accounts.md) beschreibt Anmeldung, Rechte, reine
Sitzungs-/Warenkorbprüfung und Voraussetzungen einer gesonderten Schreibfreigabe.
Eine fehlgeschlagene Sitzung oder ein blockierter Altauftrag wird nicht automatisch
entsperrt; eine bewusste Wiederaufnahme benötigt einen weiteren geprüften Schritt.

## Unveränderte Systeme

Die bestehenden Scanner-/Mock-Betriebsarten und der laufende Telegram-Einstieg
bleiben erhalten. WOG und ChangeDetection werden nicht angesprochen.
Keine VPS-Verbindung, Dienständerung, echte Freigabedatei, Bestellung, Merge oder
Bereitstellung wurde ausgeführt. Der neue Modus muss ausdrücklich gestartet
werden; Standard ist reines Lesen und simulierte Telegramzustellung.
