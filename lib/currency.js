// Multi-currency support for the menu API.
// Source-of-truth menu prices are ETB; USD is a live conversion.
export const CURRENCIES = ['ETB', 'USD'];

// ETB per 1 USD. Override in .env.local: USD_RATE=<number>
export const USD_RATE = Number(process.env.USD_RATE) || 150;

export function convertPrice(etbPrice, currency) {
  if (currency === 'USD') {
    return Math.round((etbPrice / USD_RATE) * 100) / 100;
  }
  return etbPrice;
}

export function formatPrice(price, currency) {
  if (currency === 'USD') {
    return `USD ${Number(price).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `ETB ${Number(price).toLocaleString('en-US', {
    maximumFractionDigits: 2,
  })}`;
}
