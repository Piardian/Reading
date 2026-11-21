import { TradeManagementPlan } from '../src/tradeManagement';
import { formatPrice } from '../src/assetMetrics';

export function managementInstructions(plan: TradeManagementPlan, symbol: string): string {
  const steps = plan.targets.map(target => `${formatPrice(target.price, symbol)}: %${(target.fraction * 100).toFixed(0)}`).join(' | ');
  return `${steps}. İlk gerçekleşen kademeden sonra, kapanmış M15 ile kalan pozisyonun tahmini net başabaşı hesaplanır; `
    + `stop önce bu maliyetli başabaş hesabıyla, ardından girişten sonra teyit edilen swing ile sıkılaştırılabilir. Yeni stop sonraki M15'te geçerlidir. İlk dolum için tahmini net BE: ${formatPrice(plan.estimatedNetBreakEvenPrice, symbol)}. `
    + 'Oranlar gerçek doluma göre değişir; yönetim kullanıcı tarafından uygulanır.';
}
