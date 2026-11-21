// NinjaTrader 8 indicator. Data export ONLY: no accounts, orders or trading methods.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using NinjaTrader.Cbi;
using NinjaTrader.Data;
using NinjaTrader.NinjaScript;

namespace NinjaTrader.NinjaScript.Indicators
{
    public class ReadingMarketBridge : Indicator
    {
        private readonly List<Instrument> instruments = new List<Instrument>();
        private readonly object gate = new object();
        private readonly HashSet<Instrument> subscribed = new HashSet<Instrument>();
        private BlockingCollection<string> queue;
        private Thread writerThread;
        private Timer heartbeat;
        private FileStream instanceLock;
        private string session;
        private long sequence, dropped;
        private volatile bool closing;

        [NinjaScriptProperty]
        [Display(Name="Contracts (explicit expiry, comma separated)", Order=1, GroupName="READING")]
        public string Contracts { get; set; }
        [NinjaScriptProperty]
        [Display(Name="Output directory", Order=2, GroupName="READING")]
        public string OutputDirectory { get; set; }
        [NinjaScriptProperty]
        [Display(Name="Export available Level 2 (false for Level 1 trial)", Order=3, GroupName="READING")]
        public bool ExportDepth { get; set; }
        [NinjaScriptProperty]
        [Display(Name="Feed label: UNVERIFIED / LIVE / REPLAY / DELAYED", Order=4, GroupName="READING")]
        public string FeedLabel { get; set; }

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name="ReadingMarketBridge"; Description="Read-only multi-contract market data exporter";
                Calculate=Calculate.OnEachTick; IsOverlay=true; IsSuspendedWhileInactive=false;
                Contracts="6E 12-26,6B 12-26,6A 12-26,6N 12-26,6J 12-26,6C 12-26,6S 12-26,GC 12-26";
                OutputDirectory=@"C:\Users\piard\Documents\Codex\2026-11-07\https-youtu-be-j-6bhln-d70\work\ninjatrader_feed";
                ExportDepth=false; FeedLabel="UNVERIFIED";
            }
            else if (State == State.DataLoaded)
            {
                try { StartBridge(); }
                catch (Exception ex) { Print("READING bridge refused startup: "+ex.Message); CloseBridge(); }
            }
            else if (State == State.Terminated) CloseBridge();
        }

        private void StartBridge()
        {
            Directory.CreateDirectory(OutputDirectory);
            // One exporter per output directory; never overwrite another running chart's log.
            instanceLock=new FileStream(Path.Combine(OutputDirectory,"bridge.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
            session=Guid.NewGuid().ToString("N"); closing=false;
            queue=new BlockingCollection<string>(50000);
            writerThread=new Thread(WriteLoop); writerThread.IsBackground=true; writerThread.Start();
            Emit("session_start",null,new Dictionary<string,object>{{"contracts",Contracts},{"depth_requested",ExportDepth}});
            HashSet<string> roots=new HashSet<string>();
            foreach (string text in Contracts.Split(','))
            {
                string name=text.Trim(); if (name.Length==0) continue;
                Instrument item=NinjaTrader.Cbi.Instrument.GetInstrument(name);
                if (item==null) { Emit("subscription_error",null,new Dictionary<string,object>{{"requested_contract",name}});continue; }
                if (instruments.Contains(item)) continue;
                if(!roots.Add(item.MasterInstrument.Name)) throw new InvalidOperationException("Only one expiry per root is allowed");
                instruments.Add(item);
                // Subscribe and unsubscribe on the instrument's own dispatcher.
                item.Dispatcher.InvokeAsync(new Action(delegate {
                    if (closing) return;
                    item.MarketData.Update += HandleMarketData;
                    if (ExportDepth) item.MarketDepth.Update += HandleMarketDepth;
                    lock(gate) subscribed.Add(item);
                    Emit("subscription_requested",item,new Dictionary<string,object>{{"entitlement_verified",false}});
                }));
            }
            heartbeat=new Timer(delegate { Emit("heartbeat",null,new Dictionary<string,object>{{"dropped_total",Interlocked.Read(ref dropped)}}); },null,0,2000);
            Print("READING bridge started; subscription requests are NOT proof of live data. Verify contracts and data mode.");
        }

        private void HandleMarketData(object sender,MarketDataEventArgs e)
        {
            if (e.IsReset) { Emit("reset",e.Instrument,null);return; }
            string kind;
            if (e.MarketDataType==MarketDataType.Last) kind="trade";
            else if (e.MarketDataType==MarketDataType.Bid) kind="bid";
            else if (e.MarketDataType==MarketDataType.Ask) kind="ask";
            else return;
            Emit(kind,e.Instrument,new Dictionary<string,object>{
                {"price",e.Price},{"volume",e.Volume},{"bid",e.Bid},{"ask",e.Ask},
                {"platform_time_raw",e.Time.ToString("O",CultureInfo.InvariantCulture)},
                {"platform_time_kind",e.Time.Kind.ToString()},
                {"timestamp_alignment_verified",false}});
        }

        private void HandleMarketDepth(object sender,MarketDepthEventArgs e)
        {
            Emit(e.IsReset?"reset":"depth_delta",e.Instrument,new Dictionary<string,object>{
                {"side",e.MarketDataType.ToString()},{"operation",e.Operation.ToString()},
                {"position",e.Position},{"price",e.Price},{"volume",e.Volume},
                {"platform_time_raw",e.Time.ToString("O",CultureInfo.InvariantCulture)},
                {"order_id_available",false},{"full_book_snapshot",false}});
        }

        private void Emit(string kind,Instrument item,Dictionary<string,object> extra)
        {
            lock (gate)
            {
                if (closing || queue==null || queue.IsAddingCompleted) return;
                Dictionary<string,object> row=extra??new Dictionary<string,object>();
                row["schema"]=1;row["session_id"]=session;row["sequence"]=++sequence;
                row["kind"]=kind;row["source"]="NINJATRADER_DESKTOP";
                row["received_utc_ms"]=(long)(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
                row["feed_label"]=FeedLabel;row["order_routing"]=false;
                if(item!=null) { row["contract"]=item.FullName;row["root"]=item.MasterInstrument.Name; }
                if(!queue.TryAdd(Json(row))) Interlocked.Increment(ref dropped);
            }
        }

        private void WriteLoop()
        {
            StreamWriter writer=null;string day=null;long bytes=0;DateTime checkedAt=DateTime.MinValue;
            DateTime flushedAt=DateTime.UtcNow;int pending=0;
            try
            {
                while(!queue.IsCompleted)
                {
                    string line;
                    if(!queue.TryTake(out line,200)) { if(writer!=null) writer.Flush();continue; }
                    string current=DateTime.UtcNow.ToString("yyyy-MM-dd");
                    if(day!=current)
                    {
                        if(writer!=null) writer.Dispose();
                        string file=Path.Combine(OutputDirectory,current+".jsonl");
                        bytes=File.Exists(file)?new FileInfo(file).Length:0;
                        writer=new StreamWriter(new FileStream(file,FileMode.Append,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));
                        day=current;
                    }
                    long size=Encoding.UTF8.GetByteCount(line)+2;
                    if(bytes+size>512L*1024*1024) throw new IOException("Daily export limit reached");
                    if((DateTime.UtcNow-checkedAt).TotalSeconds>=2)
                    {
                        long total=0;foreach(string f in Directory.GetFiles(OutputDirectory,"*.jsonl")) total+=new FileInfo(f).Length;
                        if(total>4L*1024*1024*1024 || new DriveInfo(Path.GetPathRoot(Path.GetFullPath(OutputDirectory))).AvailableFreeSpace<2L*1024*1024*1024)
                            throw new IOException("Storage limit reached; export stopped without deleting logs");
                        checkedAt=DateTime.UtcNow;
                    }
                    writer.WriteLine(line);bytes+=size;
                    if(++pending>=100 || (DateTime.UtcNow-flushedAt).TotalMilliseconds>=100)
                    { writer.Flush();pending=0;flushedAt=DateTime.UtcNow; }
                }
            }
            catch(Exception ex)
            {
                closing=true;
                File.WriteAllText(Path.Combine(OutputDirectory,"EXPORT_FAILED.txt"),DateTime.UtcNow.ToString("O")+" "+ex.Message);
            }
            finally { if(writer!=null) writer.Dispose(); }
        }

        private void CloseBridge()
        {
            if(heartbeat!=null) { heartbeat.Dispose();heartbeat=null; }
            Emit("session_stop",null,null);closing=true;
            foreach(Instrument item in instruments)
                if(!item.Dispatcher.HasShutdownStarted) item.Dispatcher.InvokeAsync(new Action(delegate {
                    lock(gate) { if(!subscribed.Remove(item)) return; }
                    item.MarketData.Update -= HandleMarketData;
                    if(ExportDepth) item.MarketDepth.Update -= HandleMarketDepth;
                }));
            instruments.Clear();
            lock(gate) { if(queue!=null && !queue.IsAddingCompleted) queue.CompleteAdding(); }
            if(writerThread!=null && !writerThread.Join(5000))
                Print("READING writer is still draining. Wait before adding another instance.");
            else if(instanceLock!=null) { instanceLock.Dispose();instanceLock=null; }
        }

        private static string Escape(string text)
        {
            StringBuilder s=new StringBuilder("\"");
            foreach(char c in text??"")
            {
                if(c=='"'||c=='\\') s.Append('\\').Append(c);
                else if(c<32) s.Append("\\u").Append(((int)c).ToString("x4"));
                else s.Append(c);
            }
            return s.Append('"').ToString();
        }
        private static string Json(Dictionary<string,object> row)
        {
            StringBuilder s=new StringBuilder("{");bool first=true;
            foreach(KeyValuePair<string,object> p in row)
            {
                if(!first)s.Append(',');first=false;s.Append(Escape(p.Key)).Append(':');
                if(p.Value==null)s.Append("null");
                else if(p.Value is string)s.Append(Escape((string)p.Value));
                else if(p.Value is bool)s.Append((bool)p.Value?"true":"false");
                else if(p.Value is double && (Double.IsNaN((double)p.Value)||Double.IsInfinity((double)p.Value)))s.Append("null");
                else s.Append(Convert.ToString(p.Value,CultureInfo.InvariantCulture));
            }
            return s.Append('}').ToString();
        }
    }
}
