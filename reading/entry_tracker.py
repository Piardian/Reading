"""Causal quote-driven POI lifecycle. Research proposals, never fills or execution permissions."""
import json
import math
import os
from pathlib import Path
import time
from trade_management import management_plan

TERMINAL={'EXPIRED','INVALIDATED','CANCELLED','RESEARCH_ENTRY_PROPOSAL','REJECTED'}
DEFAULTS={'setup_ttl_ms':3600000,'context_max_age_ms':35000,'quote_max_age_ms':2000,
          'max_quote_gap_ms':5000,'response_timeout_ms':600000,'min_response_quotes':3,
          'response_zone_fraction':.1,'response_spread_multiple':2,'approach_zone_multiple':1,
          'proposal_horizons_ms':[60000,300000],'require_patterns':False,'withdrawn_grace_ms':0,
          'apply_macro_gate':True}


class EntryTracker:
    def __init__(self, runtime, config=None, symbol='XAUUSD'):
        self.symbol=symbol
        self.root=Path(runtime);self.root.mkdir(parents=True,exist_ok=True)
        self.config={**DEFAULTS,**(config or {})}
        path=self.root/'entry_state.json'
        self.state=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'schema':1,'setups':{},'last_quote_received_ms':None}
        self.state.setdefault('quote_rejections',{})
        self.context=None

    def save(self):
        p=self.root/'entry_state.json';tmp=p.with_suffix('.tmp')
        try:
            tmp.write_text(json.dumps(self.state,ensure_ascii=False,indent=2),encoding='utf-8')
            for attempt in range(12):
                try:
                    os.replace(tmp,p)
                    return
                except (PermissionError,OSError):
                    time.sleep(.02*(attempt+1))
            p.write_text(json.dumps(self.state,ensure_ascii=False,indent=2),encoding='utf-8')
            tmp.unlink(missing_ok=True)
        except Exception:
            pass

    def emit(self, setup, now, kind, **details):
        event={'schema':1,'observed_utc_ms':now,'kind':kind,'setup_id':setup['id'],
               'symbol':self.symbol,'state':setup['state'],'order_routing':False,'executed':False,
               'net_pnl':None,'data':details}
        with (self.root/'entry_events.jsonl').open('a',encoding='utf-8') as f:
            f.write(json.dumps(event,ensure_ascii=False,separators=(',',':'))+'\n')

    def transition(self, s, state, now, reason, **details):
        s['state']=state;s['reason']=reason;s['updated_utc_ms']=now
        self.emit(s,now,'STATE_TRANSITION',reason=reason,**details)

    def _revoke_by_macro_preflight(self, context, now):
        if not self.config.get('apply_macro_gate', True):
            return
        preflights = context.get('macro_preflight') or {}
        if not preflights:
            return
        for s in self.state['setups'].values():
            if s['state'] in TERMINAL:
                continue
            preflight = preflights.get(s['direction']) or {}
            if preflight and (preflight.get('multiplier') != 1 or preflight.get('isStale') is True):
                self.transition(s, 'CANCELLED', now, 'MACRO_APPROVAL_REVOKED')

    def _protect_touched_from_stale_context(self, s, now):
        return s['state'] in {'TOUCHED', 'WAITING_RESPONSE'} and now - s.get('touch_utc_ms', 0) <= self.config['response_timeout_ms']

    def sync(self, context, now):
        if not isinstance(context, dict):return
        stamp=context.get('observed_utc_ms')
        stamp_fresh=isinstance(stamp,(int,float)) and 0<=now-stamp<=self.config['context_max_age_ms']
        incoming_fresh=stamp_fresh and context.get('state') in {'CANDIDATES_OBSERVED','NO_SETUP'}
        if not incoming_fresh:
            if stamp_fresh:
                self._revoke_by_macro_preflight(context, now)
            if self.context is None:
                self.context=context
            return
        self.context=context
        current=set()
        for candidate in context.get('candidates',[]):
            key=candidate.get('signalId') or candidate.get('uniqueKey')
            if not key or candidate.get('symbol')!=self.symbol:continue
            current.add(key)
            if key in self.state['setups']:continue
            poi=candidate.get('poi',{});plan=candidate.get('expectancyPlan') or {}
            low=poi.get('gapLow') if candidate.get('poiType')=='FVG' else poi.get('low')
            high=poi.get('gapHigh') if candidate.get('poiType')=='FVG' else poi.get('high')
            stop=plan.get('stopLoss');target=(plan.get('tp2' if self.config.get('management') else 'tp1') or {}).get('price')
            direction=candidate.get('tradeDirection')
            s={'id':key,'state':'REGISTERED','direction':direction,'low':low,'high':high,
               'stop':stop,'target':target,'registered_utc_ms':now,'expires_utc_ms':now+self.config['setup_ttl_ms'],
               'plan':plan,'original_candidate':candidate,'last_observed_utc_ms':context['observed_utc_ms'],
               'input_hashes':context.get('input_hashes',{}),'reference_observations':{}}
            self.state['setups'][key]=s
            values=[low,high,stop,target]
            valid=all(isinstance(v,(int,float)) and math.isfinite(v) and v>0 for v in values)
            valid=valid and low<high and (stop<low<target if direction=='long' else target<high<stop if direction=='short' else False)
            if not valid:
                self.transition(s,'REJECTED',now,'INVALID_OR_MISSING_ZONE_STOP_TARGET');continue
            if not self.macro_allowed(candidate):
                self.transition(s,'REJECTED',now,'MACRO_NOT_APPROVED');continue
            if candidate.get('gradeResult',{}).get('entryAllowed') is not True:
                self.transition(s,'REJECTED',now,'SMC_NOT_APPROVED');continue
            self.emit(s,now,'SETUP_REGISTERED',zone=[low,high],stop=stop,target=target,
                      baseline_planned_entry=plan.get('entryPrice'),scope='BEGONYA_MACRO_SMC_THEN_READING')
        by_id={(c.get('signalId') or c.get('uniqueKey')):c for c in context.get('candidates',[])}
        for key,s in self.state['setups'].items():
            if s['state'] in TERMINAL:continue
            if key not in current:
                # If current cycle provides fresh macro preflight for this symbol and it is explicitly vetoed,
                # active/touched setups cannot bypass revocation just because they are in active_states.
                preflight = (context.get('macro_preflight') or {}).get(s['direction']) or {}
                if self.config.get('apply_macro_gate', True) and preflight and (preflight.get('multiplier') != 1 or preflight.get('isStale') is True):
                    self.transition(s,'CANCELLED',now,'MACRO_APPROVAL_REVOKED')
                    continue
                active_states={'APPROACHING','TOUCHED','WAITING_RESPONSE'}
                grace_ms=self.config.get('withdrawn_grace_ms',0)
                last_seen=s.get('last_observed_utc_ms', s.get('registered_utc_ms', 0))
                if s['state'] in active_states or (grace_ms>0 and now - last_seen < grace_ms):
                    continue
                self.transition(s,'CANCELLED',now,'SETUP_WITHDRAWN_BY_FRESH_SMC');continue
            candidate=by_id[key]
            if not self.macro_allowed(candidate):
                self.transition(s,'CANCELLED',now,'MACRO_APPROVAL_REVOKED');continue
            if candidate.get('gradeResult',{}).get('entryAllowed') is not True:
                self.transition(s,'CANCELLED',now,'SMC_APPROVAL_REVOKED');continue
            s['last_observed_utc_ms']=context['observed_utc_ms']

    def macro_allowed(self, candidate):
        if not self.config.get('apply_macro_gate', True):
            return True
        m=candidate.get('macroEvaluation') or {}
        return m.get('allowed') is True and m.get('macroGateMultiplier')==1 and m.get('isStale') is not True

    def context_fresh(self, now):
        c=self.context or {};stamp=c.get('observed_utc_ms')
        return isinstance(stamp,(int,float)) and 0<=now-stamp<=self.config['context_max_age_ms'] and c.get('state') in {'CANDIDATES_OBSERVED','NO_SETUP'}

    def tick(self, event, tape, now):
        received=event.get('received_utc_ms',0);q=event.get('data',{})
        legacy=event.get('kind')=='xauusd_broker_tick' and self.symbol=='XAUUSD'
        forex=event.get('kind')=='broker_quote_tick' and q.get('symbol')==self.symbol
        crypto=event.get('kind')=='crypto_quote_tick' and q.get('symbol')==self.symbol and q.get('market')=='BINANCE_SPOT' and q.get('quote_asset')=='USDT'
        if not (legacy or forex or crypto):return
        if not 0<=now-received<=self.config['quote_max_age_ms']:
            self.reject_quote('OLD_OR_FUTURE_RECEIPT');return
        if self.state.get('last_quote_received_ms') is not None and received<self.state['last_quote_received_ms']:
            self.reject_quote('OUT_OF_ORDER_RECEIPT');return
        bid,ask=q.get('bid'),q.get('ask')
        if not all(isinstance(v,(int,float)) and math.isfinite(v) and v>0 for v in [bid,ask]) or ask<bid:
            self.reject_quote('INVALID_BID_ASK');return
        self.state['last_quote_received_ms']=received
        broker_ms=q.get('time_msc')
        if crypto and q.get('timestamp_source')!='LOCAL_RECEIPT_TIME_NO_EXCHANGE_TIMESTAMP_IN_BOOKTICKER':
            self.reject_quote('CRYPTO_QUOTE_TIMESTAMP_PROVENANCE_INVALID');return
        if not crypto and (not isinstance(broker_ms,(int,float)) or not -2000<=now-broker_ms<=self.config['quote_max_age_ms']):
            self.reject_quote('FUTURE_OR_STALE_BROKER_TIMESTAMP');return
        for s in self.state['setups'].values():
            if received<s['registered_utc_ms']:continue
            self.mark_references(s,event,now)
            if s['state'] in TERMINAL:continue
            if now>=s['expires_utc_ms']:
                self.transition(s,'EXPIRED',now,'SETUP_TTL');continue
            if not self.context_fresh(now) and not self._protect_touched_from_stale_context(s, now):
                self.suspend(s,now,'SMC_CONTEXT_NOT_FRESH');continue
            long=s['direction']=='long';execution=ask if long else bid;exit_quote=bid if long else ask
            if (long and exit_quote<=s['stop']) or (not long and exit_quote>=s['stop']):
                self.transition(s,'INVALIDATED',now,'ORIGINAL_STOP_BREACHED',bid=bid,ask=ask);continue
            previous=s.get('last_quote_ms');s['last_quote_ms']=received
            if previous and received-previous>self.config['max_quote_gap_ms']:
                self.suspend(s,now,'QUOTE_GAP_RESPONSE_RESET')
            if s['state']=='SUSPENDED':
                self.transition(s,'REGISTERED',now,'DATA_RESUMED_REQUIRES_NEW_TOUCH')
            width=s['high']-s['low'];mid=(bid+ask)/2
            in_zone=s['low']<=execution<=s['high']
            distance=max(s['low']-execution,execution-s['high'],0)
            if s['state'] in {'REGISTERED','APPROACHING'}:
                if in_zone:
                    s.update({'touch_utc_ms':received,'touch_mid':mid,'touch_spread':ask-bid,'response_quotes':0,'extreme_mid':mid})
                    s['reference_observations'].setdefault('first_touch',{'entry_quote':execution,'observed_utc_ms':now,
                        'quote_received_utc_ms':received,'bid':bid,'ask':ask,'last_mark_ms':received,'marks':{},'coverage_lost':False})
                    self.transition(s,'TOUCHED',now,'EXECUTABLE_QUOTE_IN_ZONE',entry_quote=execution,bid=bid,ask=ask,
                                    baseline='FIRST_TOUCH_QUOTE_REFERENCE_NOT_BEGONYA_FILL')
                elif distance<=width*self.config['approach_zone_multiple'] and s['state']=='REGISTERED':
                    self.transition(s,'APPROACHING',now,'WITHIN_ONE_ZONE_WIDTH')
                continue
            if now-s['touch_utc_ms']>self.config['response_timeout_ms']:
                self.transition(s,'EXPIRED',now,'NO_RESPONSE_WITHIN_WINDOW');continue
            s['response_quotes']+=1
            s['extreme_mid']=min(s['extreme_mid'],mid) if long else max(s['extreme_mid'],mid)
            if s['state']=='TOUCHED':self.transition(s,'WAITING_RESPONSE',now,'POST_TOUCH_QUOTES')
            if not tape or tape.get('generated_utc_ms',now+1)>received or received-tape.get('generated_utc_ms',0)>2000:
                continue
            adverse='SELL' if long else 'BUY';aligned='BUY' if long else 'SELL'
            progress=mid-s['touch_mid'] if long else s['touch_mid']-mid
            usable=tape.get('tape_features_usable',tape.get('paxg_features_usable',False))
            is_cross=tape.get('state')=='CROSS_LEGS_CONTEXT_ONLY' or (tape.get('mapping') or {}).get('mode')=='CROSS_LEGS_CONTEXT_ONLY'
            if ((usable and tape.get('research_pressure')==adverse) or is_cross) and abs(progress)<=width*.1:
                if not s.get('stall_observed'):
                    s['stall_observed']=True;self.emit(s,now,'OPPOSING_PROXY_FLOW_WITH_LOW_XAU_PROGRESS' if self.symbol=='XAUUSD' else 'OPPOSING_FLOW_WITH_LOW_SPOT_PROGRESS',
                        classification='RESEARCH_STALL_PATTERN_NOT_CONFIRMED_ABSORPTION')
            pattern_ok=True
            if self.config['require_patterns']:
                pattern_ok=self.observe_patterns(s,tape,received,now,aligned)
            response=mid-s['extreme_mid'] if long else s['extreme_mid']-mid
            threshold=max(width*self.config['response_zone_fraction'],(ask-bid)*self.config['response_spread_multiple'])
            if s['response_quotes']<self.config['min_response_quotes'] or response<threshold:continue
            if self.config['require_patterns']:
                if not pattern_ok:continue
            elif not usable or tape.get('research_pressure')!=aligned:continue
            entry_range=s['plan'].get('entryRange')
            if entry_range and not self.config.get('management') and not entry_range['low']<=execution<=entry_range['high']:continue
            risk=execution-s['stop'] if long else s['stop']-execution
            reward=s['target']-execution if long else execution-s['target']
            if risk<=0 or reward<=0:continue
            if self.config.get('management'):
                try:s['management']=management_plan(s,execution,self.config['management'])
                except ValueError as e:
                    if str(e)=='ACTUAL_ENTRY_RR_BELOW_2' and entry_range and not (execution<=entry_range['high'] if long else execution>=entry_range['low']):
                        self.transition(s,'REJECTED',now,str(e));continue
                    self.transition(s,'REJECTED',now,str(e));continue
                s['target']=s['management']['tp2']
                reward=abs(s['target']-execution)
            s['reference_observations']['reading_proposal']={'entry_quote':execution,'observed_utc_ms':now,
                'quote_received_utc_ms':received,'bid':bid,'ask':ask,'last_mark_ms':received,'marks':{},'coverage_lost':False}
            self.transition(s,'RESEARCH_ENTRY_PROPOSAL',now,'PRICE_RESPONSE_AND_ALIGNED_PROXY_FLOW',
                entry_quote=execution,bid=bid,ask=ask,quote_received_utc_ms=received,quote_age_at_decision_ms=now-received,
                response=response,response_threshold=threshold,
                gross_quote_rr=reward/risk,tape_cutoff_ms=tape['generated_utc_ms'],
                actionable=True,blocked_by=[],
                stop=s['stop'],targets={k:s['plan'].get(k) for k in ['tp1','tp2','tp3']},
                absorption_confirmed=True,spoofing_identified=False,
                reading_pattern_evidence=s.get('pattern_assessment') if self.config['require_patterns'] else None,
                market_identity=tape.get('market_identity'),
                rule_version='AUTOMATIC_PATTERNS_V1' if self.config['require_patterns'] else 'PRICE_RESPONSE_AND_PRESSURE_CONTROL')

    def observe_patterns(self,s,tape,received,now,aligned):
        is_cross=tape.get('state')=='CROSS_LEGS_CONTEXT_ONLY' or (tape.get('mapping') or {}).get('mode')=='CROSS_LEGS_CONTEXT_ONLY'
        p=tape.get('reading_patterns') or {}
        if is_cross:
            pulls=p.get('liquidity_pulls') or {}
            response=p.get('response_flow') or {}
            if s.get('stall_observed') and s.get('response_quotes',0)>=self.config['min_response_quotes']:
                reason='AUTOMATIC_PATTERN_CONFIRMATION_RESEARCH_ONLY'
            else:
                reason='WAITING_POST_TOUCH_SPEED_AND_ABSORPTION_CANDIDATE'
            s['pattern_assessment']={'state':reason,'absorption_evidence':[],
                'source_usable':True,'source_state':tape.get('state'),
                'source_reasons':tape.get('reasons',[]),'mapping':tape.get('mapping'),
                'response_flow':response,'liquidity_pull_state':pulls.get('state','UNAVAILABLE_NO_LEVEL2'),
                'recent_liquidity_pull_cautions':0,'human_confirmation_required':False,
                'spoofing_confirmed':False,'absorption_confirmed':False,'execution_allowed':False}
            return reason=='AUTOMATIC_PATTERN_CONFIRMATION_RESEARCH_ONLY'
        valid_source=tape.get('tape_features_usable') is True and p.get('source_usable') is True and 0<=received-p.get('generated_utc_ms',received+1)<=10000
        evidence=s.setdefault('pattern_evidence',{})
        for candidate in p.get('absorption_candidates',[]):
            if not valid_source or candidate.get('usable') is not True or candidate.get('direction')!=aligned:continue
            if not s['touch_utc_ms']<=candidate.get('window_start_utc_ms',-1)<=candidate.get('detected_utc_ms',-1)<=received:continue
            if candidate['id'] not in evidence:
                evidence[candidate['id']]=candidate
                self.emit(s,now,'AUTOMATIC_ABSORPTION_CANDIDATE',evidence=candidate)
        evidence={k:v for k,v in evidence.items() if v.get('valid_until_utc_ms',-1)>=received}
        s['pattern_evidence']=evidence
        pulls=p.get('liquidity_pulls') or {}
        suspicious=[e for e in pulls.get('candidates',[]) if e.get('usable') is True and
            s['touch_utc_ms']<=e.get('appeared_utc_ms',-1)<=e.get('detected_utc_ms',-1)<=received<=e.get('valid_until_utc_ms',-1)]
        for e in suspicious:
            seen=s.setdefault('liquidity_pull_ids',[])
            if e['id'] not in seen:
                seen.append(e['id']);self.emit(s,now,'AUTOMATIC_LIQUIDITY_PULL_CAUTION',evidence=e)
        response=p.get('response_flow') or {}
        if not valid_source:reason='PATTERN_SOURCE_NOT_VALIDATED'
        elif not evidence:reason='WAITING_POST_TOUCH_SPEED_AND_ABSORPTION_CANDIDATE'
        elif suspicious:reason='WAITING_RECENT_LIQUIDITY_PULL_CAUTION'
        elif response.get('usable') is not True or response.get('direction')!=aligned:reason='WAITING_AGGRESSIVE_FLOW_REVERSAL'
        else:reason='AUTOMATIC_PATTERN_CONFIRMED'
        confirmed=(reason=='AUTOMATIC_PATTERN_CONFIRMED')
        s['pattern_assessment']={'state':reason,'absorption_evidence':list(evidence.values()),
            'source_usable':valid_source,'source_state':tape.get('state'),
            'source_reasons':tape.get('reasons',[]),'mapping':tape.get('mapping'),
            'response_flow':response,'liquidity_pull_state':pulls.get('state','UNAVAILABLE_NO_LEVEL2'),
            'recent_liquidity_pull_cautions':len(suspicious),'human_confirmation_required':False,
            'spoofing_confirmed':False,'absorption_confirmed':confirmed,'execution_allowed':confirmed}
        return confirmed

    def suspend(self,s,now,reason):
        if s['state']!='SUSPENDED':self.transition(s,'SUSPENDED',now,reason)
        for key in ['touch_utc_ms','touch_mid','response_quotes','extreme_mid','stall_observed','pattern_evidence','pattern_assessment','liquidity_pull_ids']:
            s.pop(key,None)

    def reject_quote(self, reason):
        counts=self.state['quote_rejections'];counts[reason]=counts.get(reason,0)+1

    def mark_references(self,s,event,now):
        q=event['data'];received=event['received_utc_ms']
        exit_quote=q['bid'] if s['direction']=='long' else q['ask']
        for label,reference in s['reference_observations'].items():
            if received<reference['observed_utc_ms']:continue
            if received-reference['last_mark_ms']>self.config['max_quote_gap_ms']:reference['coverage_lost']=True
            reference['last_mark_ms']=received
            for horizon in self.config['proposal_horizons_ms']:
                name=str(horizon)
                if name in reference['marks'] or received<reference['observed_utc_ms']+horizon:continue
                available=received-reference['observed_utc_ms']-horizon<=self.config['quote_max_age_ms'] and not reference['coverage_lost']
                move=exit_quote-reference['entry_quote'] if s['direction']=='long' else reference['entry_quote']-exit_quote
                reference['marks'][name]={'status':'OBSERVED_QUOTES_ONLY' if available else 'UNAVAILABLE_GAP_OR_LATE_LABEL',
                    'quote_price_change':move if available else None,'net_pnl':None}
                self.emit(s,now,'REFERENCE_MARK',reference=label,horizon_ms=horizon,**reference['marks'][name],
                          fills_verified=False,slippage=None,commission=None)

    def advance(self,now):
        for s in self.state['setups'].values():
            if s['state'] in TERMINAL:continue
            if now>=s['expires_utc_ms']:self.transition(s,'EXPIRED',now,'SETUP_TTL')
            elif not self.context_fresh(now) and not self._protect_touched_from_stale_context(s, now):self.suspend(s,now,'SMC_CONTEXT_NOT_FRESH')
            elif s.get('last_quote_ms') and now-s['last_quote_ms']>self.config['max_quote_gap_ms']:
                self.suspend(s,now,'QUOTE_STREAM_NOT_FRESH')
        return {'states':self.counts(),'total_setups':len(self.state['setups']),
                'entry_rule':'AUTOMATIC_PATTERNS_V1' if self.config['require_patterns'] else 'PRICE_RESPONSE_AND_PRESSURE_CONTROL',
                'pattern_gates':{reason:sum(s.get('pattern_assessment',{}).get('state')==reason for s in self.state['setups'].values())
                    for reason in {s.get('pattern_assessment',{}).get('state') for s in self.state['setups'].values()} if reason},
                'quote_rejections':dict(self.state['quote_rejections']),
                'order_routing':False,'execution_permissions':False,'net_pnl':None}

    def counts(self):
        counts={}
        for s in self.state['setups'].values():counts[s['state']]=counts.get(s['state'],0)+1
        return counts
