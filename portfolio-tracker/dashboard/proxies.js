// US-listed stand-ins for UCITS tickers TickerInside does not cover.
// The holding is the same asset class, not a copy of the fund.
export const SUGGESTED_PROXIES = {
  CSPX: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  CSSPX: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  SXR8: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  VUAA: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  VUSA: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  SPY5: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  IUSA: { proxy: "VOO", note: "S&P 500 UCITS, наближення через VOO" },
  VWCE: { proxy: "VT", note: "FTSE All-World UCITS, наближення через VT" },
  VALU: { proxy: "VT", note: "Vanguard FTSE Global All Cap UCITS, наближення через VT" },
  V3AA: { proxy: "VT", note: "Vanguard FTSE Global All Cap UCITS, наближення через VT" },
  V3AB: { proxy: "VT", note: "Vanguard FTSE Global All Cap UCITS, наближення через VT" },
  V3AL: { proxy: "VT", note: "Vanguard FTSE Global All Cap UCITS, наближення через VT" },
  VWRA: { proxy: "VT", note: "FTSE All-World UCITS, наближення через VT" },
  VWRL: { proxy: "VT", note: "FTSE All-World UCITS, наближення через VT" },
  VWRP: { proxy: "VT", note: "FTSE All-World UCITS, наближення через VT" },
  IWDA: { proxy: "URTH", note: "MSCI World UCITS, наближення через URTH" },
  SWDA: { proxy: "URTH", note: "MSCI World UCITS, наближення через URTH" },
  SWRD: { proxy: "URTH", note: "MSCI World UCITS, наближення через URTH" },
  EUNL: { proxy: "URTH", note: "MSCI World UCITS, наближення через URTH" },
  EIMI: { proxy: "IEMG", note: "MSCI EM UCITS, наближення через IEMG" },
  IS3N: { proxy: "IEMG", note: "MSCI EM UCITS, наближення через IEMG" },
  EMIM: { proxy: "IEMG", note: "MSCI EM UCITS, наближення через IEMG" },
  EQQQ: { proxy: "QQQ", note: "Nasdaq-100 UCITS, наближення через QQQ" },
  CNDX: { proxy: "QQQ", note: "Nasdaq-100 UCITS, наближення через QQQ" },
  SXRV: { proxy: "QQQ", note: "Nasdaq-100 UCITS, наближення через QQQ" },
  CSNDX: { proxy: "QQQ", note: "Nasdaq-100 UCITS, наближення через QQQ" },
  SGLN: { proxy: "GLD", note: "золото UCITS, наближення через GLD" },
  IGLN: { proxy: "GLD", note: "золото UCITS, наближення через GLD" },
  SGLD: { proxy: "GLD", note: "золото UCITS, наближення через GLD" },
  "4GLD": { proxy: "GLD", note: "золото UCITS, наближення через GLD" },
  PHAU: { proxy: "GLD", note: "золото UCITS, наближення через GLD" },
  EGLN: { proxy: "GLD", note: "золото UCITS, наближення через GLD" },
  SSLN: { proxy: "SLV", note: "срібло UCITS, наближення через SLV" },
  ISLN: { proxy: "SLV", note: "срібло UCITS, наближення через SLV" },
  AGGH: { proxy: "BND", note: "облігації UCITS, грубе наближення через BND" },
  VAGF: { proxy: "BND", note: "облігації UCITS, грубе наближення через BND" },
  VAGU: { proxy: "BND", note: "облігації UCITS, грубе наближення через BND" },
};

// UCITS funds TickerInside does not file, classified by what the fund is.
// AGGU is iShares Core Global Aggregate Bond, not a metal.
export const ASSET_CLASS_HINTS = {
  AGGU: { bucket: "bonds", label: "Глобальні облігації", note: "iShares Core Global Aggregate Bond UCITS, USD hedged" },
  AGGG: { bucket: "bonds", label: "Глобальні облігації", note: "iShares Core Global Aggregate Bond UCITS" },
  EUNA: { bucket: "bonds", label: "Глобальні облігації", note: "iShares Core Global Aggregate Bond UCITS" },
};
