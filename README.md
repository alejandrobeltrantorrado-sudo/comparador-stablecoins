# Comparador de stablecoins vs Buda (versión simple, sin dependencias)

Compara precios de USDC/USDT en COP de la competencia contra Buda.
NO usa librerías externas: solo Node. No hay que instalar nada.

## Archivos (todos SUELTOS, sin carpetas)
- server.js
- package.json
- index.html
- cbp.html
- platform-rates.json   (empieza en {} ; guarda las tasas capturadas a mano)

## Subir a GitHub (por la web)
Add file -> Upload files -> arrastra los 5 archivos -> Commit. No hay carpetas que subir.

## Desplegar en Railway
New Project -> Deploy from GitHub repo -> elige el repo. Railway corre `npm start`
(que es `node server.js`). No instala dependencias porque no hay.

## Variables opcionales (Railway -> Variables)
- MURAL_API_KEY : activa el benchmark B2B en /cbp.html (Mural Pay).
- MURAL_API_BASE : https://api-staging.muralpay.com  (para sandbox).
- PLENTI_ENDPOINT_JSON : JSON del cotizador de Plenti (cuando captures el endpoint), p.ej.:
  {"url":"https://.../quote","method":"GET","query":{"from":"USD","to":"COP","amount":"1"},"askPath":"data.rate","bidPath":"data.rate","coin":"usdc"}

## Fuentes
CriptoYa, Buda directo, Bitso directo (USDT/COP), Binance P2P, OKX P2P (verificados),
Bybit P2P (marcado sin verificar), captura manual (Plenti/Littio/VIIO/Wenia),
Plenti web (si defines PLENTI_ENDPOINT_JSON), y Mural en /cbp.html.

Páginas: /  (comparador retail)  y  /cbp.html  (benchmark B2B).
