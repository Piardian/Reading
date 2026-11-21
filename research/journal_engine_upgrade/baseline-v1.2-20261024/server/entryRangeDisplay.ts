import type { NotificationCandidate } from './pipeline';
import { formatPrice } from '../src/assetMetrics';

export function describeEntryRange(candidate: NotificationCandidate) {
  const range = candidate.expectancyPlan?.entryRange;
  if (!range) return null;
  const inRange = candidate.currentPrice >= range.low && candidate.currentPrice <= range.high;
  const text = `${formatPrice(range.low, candidate.symbol)} - ${formatPrice(range.high, candidate.symbol)}`;
  return {
    inRange, text,
    requiredAction: inRange
      ? 'Fiyat net R:R giriş aralığında; mevcut 1 dakikalık manuel onayı bekle.'
      : `Net ${range.minimumNetRR.toFixed(1)}R için ${text} giriş aralığını bekle; aralık dışında işlem yok.`,
    requiredConfirmation: 'Gerçek giriş fiyatında maliyet ve R:R yeniden kontrol edilmeli; M1 giriş kararı kullanıcıya aittir.',
  };
}
