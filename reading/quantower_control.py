"""Local opt-in/stop controls for the data-only Quantower background host."""
import json
from pathlib import Path
import sys

HERE=Path(__file__).resolve().parent
def main():
    action=sys.argv[1] if len(sys.argv)>1 else 'status'
    config_path=HERE/'quantower/autostart.json'
    cfg=json.loads(config_path.read_text(encoding='utf-8'))
    feed=Path(json.loads((HERE/'config.json').read_text(encoding='utf-8'))['quantower_feed_directory'])
    feed.mkdir(parents=True,exist_ok=True)
    if action=='stop':
        (feed/'STOP').touch();cfg['enabled']=False
    elif action=='start':
        cfg['enabled']=True;(feed/'STOP').unlink(missing_ok=True)
    elif action!='status':raise SystemExit('start|stop|status')
    if action in {'start','stop'}:
        config_path.write_text(json.dumps(cfg,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('Data-only host enabled:',cfg['enabled'],'; STOP marker:',(feed/'STOP').exists())
    print('No orders. Quantower must remain open. Heartbeat, not this command, verifies startup/stop.')
if __name__=='__main__':main()
