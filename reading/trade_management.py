"""Frozen shadow risk policy. USD figures are R-scaled model amounts, not lot sizing."""
import math
POLICY={'version':'SHADOW_100USD_HALF_1R_BE_LIQUIDITY_V1','risk_usd':100.,'partial_at_r':1.,
    'partial_fraction':.5,'move_remaining_to_entry':True,'minimum_target_rr':2.,'require_liquidity_target':True}

def management_plan(setup,entry,policy):
    if policy!=POLICY:raise ValueError('UNSUPPORTED_MANAGEMENT_POLICY')
    plan=setup.get('plan') or {};target=(plan.get('tp2') or {}).get('price');magnet=plan.get('resolvedLiquidityMagnet') or {}
    constraint=plan.get('targetConstraint');stop=setup.get('stop');sign=1 if setup.get('direction')=='long' else -1
    if constraint not in {'LIQUIDITY','OBSTACLE'}:
        raise ValueError('ACTIVE_LIQUIDITY_TP2_REQUIRED')
    if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and v>0 for v in [entry,stop,target]):
        raise ValueError('INVALID_MANAGEMENT_GEOMETRY')
    if constraint=='LIQUIDITY':
        if magnet.get('isActive') is not True or magnet.get('status') in ['TAKEN','INVALIDATED']:
            raise ValueError('ACTIVE_LIQUIDITY_TP2_REQUIRED')
        pool=magnet.get('priceLevel')
        if not (isinstance(pool,(int,float)) and not isinstance(pool,bool) and math.isfinite(pool) and pool>0):
            raise ValueError('INVALID_MANAGEMENT_GEOMETRY')
        # Allow exact pool or 4.5R-capped target before the pool; reject targets beyond the pool.
        if sign*(pool-target)<-max(1e-10*abs(target),1e-12):raise ValueError('TP2_NOT_AT_FROZEN_LIQUIDITY_POOL')
        if magnet.get('type')!=('EQH' if sign==1 else 'EQL'):raise ValueError('WRONG_DIRECTION_LIQUIDITY_POOL')
    risk=sign*(entry-stop);reward=sign*(target-entry)
    if risk<=0 or reward<=0 or reward/risk<2.-1e-12:raise ValueError('ACTUAL_ENTRY_RR_BELOW_2')
    return {**POLICY,'entry':entry,'initial_stop':stop,'risk_distance':risk,'tp1':entry+sign*risk,
        'tp2':target,'target_rr':reward/risk,'liquidity_pool':dict(magnet) if magnet else {'type':'OBSTACLE','priceLevel':target},'scope':'R_SCALED_USD_SHADOW_NOT_BROKER_POSITION_SIZE'}
