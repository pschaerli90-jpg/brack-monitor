# Testdaten

`products.json` enthält weiterhin die ursprünglichen Offline-Fixtures.

`brack-listing.html` ist ein bereinigter öffentlicher Leseabruf der angegebenen
BRACK-URL vom 2. November 2026. Enthalten sind nur die 32 Produktdatensätze,
deren Reihenfolge und drei Listenmetadaten aus `b2c-search-products` und
`b2c-search-datalayer`. Header, Cookies, INITIAL_STATE, Tracking- und Sitzungsdaten
wurden nicht übernommen. Namen und Bestände sind historische Testdaten.
Dieser Snapshot enthält keine Zielprodukte: die englische Priorisierung und die
deutsche Jubiläumsserie werden mit synthetischen Datensätzen im selben Schema
unter `test/helpers/brack.js` getestet.
