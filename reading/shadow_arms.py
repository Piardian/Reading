"""Independent forward-only experiment accounts; only control A may notify."""
from shadow_ledger import ShadowLedger


class SilentNotifications:
    def has(self,key):return True
    def enqueue(self,key,message):pass


class ShadowArms:
    def __init__(self,runtime,notifier,management=None,max_quote_gap_ms=60000):
        self.ledgers={}
        for arm in 'ABCD':
            folder=runtime if arm=='A' else runtime/'arms'/arm
            folder.mkdir(parents=True,exist_ok=True)
            self.ledgers[arm]=ShadowLedger(folder,notifier if arm=='A' else SilentNotifications(),management,max_quote_gap_ms=max_quote_gap_ms)

    def quote(self,symbol,event,now):
        for ledger in self.ledgers.values():ledger.quote(symbol,event,now)

    def register(self,trackers,now):
        for arm,tracker in trackers.items():self.ledgers[arm].register([tracker],now)

    def advance(self,now):
        for ledger in self.ledgers.values():ledger.advance(now)

    def summary(self):
        return {arm:ledger.summary() for arm,ledger in self.ledgers.items()}
