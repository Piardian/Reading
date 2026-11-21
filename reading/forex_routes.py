"""Coverage map: futures tape and spot FX are different venues."""
MAJORS={
    'EURUSD':('6E',False),'GBPUSD':('6B',False),'AUDUSD':('6A',False),
    'NZDUSD':('6N',False),'USDJPY':('6J',True),'USDCAD':('6C',True),'USDCHF':('6S',True)}
CURRENCIES={'EUR':'6E','GBP':'6B','AUD':'6A','NZD':'6N','JPY':'6J','CAD':'6C','CHF':'6S'}
SYMBOLS=list(MAJORS)+['AUDCAD','EURGBP','EURJPY','GBPJPY','CADJPY','AUDJPY','EURAUD',
    'NZDCAD','EURCHF','GBPCHF','AUDCHF','CADCHF','NZDCHF','CHFJPY']

def route(symbol):
    if symbol=='XAUUSD':return {'mode':'DIRECT_FUTURES_PROXY','root':'GC','inverse':False}
    if symbol in MAJORS:
        root,inverse=MAJORS[symbol]
        return {'mode':'DIRECT_FUTURES_PROXY','root':root,'inverse':inverse}
    if len(symbol)==6 and symbol[:3] in CURRENCIES and symbol[3:] in CURRENCIES:
        return {'mode':'CROSS_LEGS_CONTEXT_ONLY','legs':[CURRENCIES[symbol[:3]],CURRENCIES[symbol[3:]]],
                'reason':'No dedicated cross tape connected; legs are not the cross order book'}
    return {'mode':'NO_TAPE','reason':'No feed mapping configured'}
