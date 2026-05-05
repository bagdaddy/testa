CREATE DICTIONARY IF NOT EXISTS fx_rates
(
    date     DateTime,
    from_ccy String,
    to_ccy   String,
    rate     Float64
)
PRIMARY KEY date, from_ccy, to_ccy
SOURCE(HTTP(URL 'http://collector:8000/_internal/fx-rates' FORMAT 'JSONEachRow'))
LIFETIME(86400)
LAYOUT(COMPLEX_KEY_HASHED());
