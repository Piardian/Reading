// Data export only. No account access, trading operations, network server or order API.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using TradingPlatform.BusinessLayer;

[assembly: System.Reflection.AssemblyVersion("1.0.3.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.3.0")]
[assembly: System.Runtime.Versioning.TargetFramework(".NETCoreApp,Version=v10.0", FrameworkDisplayName=".NET 10.0")]

namespace Reading.DataOnly
{
    public sealed class ReadingQuantowerBridge : Strategy
    {
        [InputParameter("CQG symbols (explicit expiry)", 10)]
        public string Contracts = "EU6Z26,BP6Z26,DA6Z26,NE6Z26,JY6Z26,CA6Z26,SF6Z26,GCEZ26";
        [InputParameter("Connection name (exact)", 20)]
        public string ConnectionName = "AMP/CQG";
        [InputParameter("Output directory", 30)]
        public string OutputDirectory = @"C:\Users\piard\Documents\Codex\2026-11-07\https-youtu-be-j-6bhln-d70\work\quantower_feed";
        [InputParameter("Export available depth", 40)]
        public bool ExportDepth = false;
        [InputParameter("Feed label: UNVERIFIED / LIVE / DELAYED / REPLAY", 50)]
        public string FeedLabel = "UNVERIFIED";

        private static readonly Dictionary<string,string> Roots = new Dictionary<string,string> {
            {"EU6","6E"},{"BP6","6B"},{"DA6","6A"},{"NE6","6N"},
            {"JY6","6J"},{"CA6","6C"},{"SF6","6S"},{"GCE","GC"}};
        private static readonly Regex ContractPattern = new Regex(@"^(EU6|BP6|DA6|NE6|JY6|CA6|SF6|GCE)([FGHJKMNQUVXZ])(\d{2})$");
        private readonly object gate = new object();
        private readonly List<Symbol> subscribed = new List<Symbol>();
        private readonly Dictionary<Symbol,Tuple<string,string>> identities = new Dictionary<Symbol,Tuple<string,string>>();
        private readonly Dictionary<string,long> lastTrade = new Dictionary<string,long>();
        private readonly Dictionary<string,long> lastQuoteExport = new Dictionary<string,long>();
        private BlockingCollection<string> queue;
        private Thread writer;
        private Timer timer;
        private FileStream instanceLock;
        private Connection connection;
        private string session, failure;
        private long sequence, dropped, trades, quotes, depths, quoteExports;
        private volatile bool closing = true;
        private bool ownsLock;
        private readonly bool backgroundHost;
        private static Timer autoTimer;
        private static ReadingQuantowerBridge autoHost;
        private static int autoBusy;
        private const string AutoConfig=@"C:\Users\piard\Documents\Codex\2026-11-07\https-youtu-be-j-6bhln-d70\outputs\READİNG\reading\quantower\autostart.json";

        public ReadingQuantowerBridge() : this(false) {
            // Explicit local opt-in only. The catalog constructor registers a data-only
            // host; no StrategyManager Run, account or order operation is involved.
            if(File.Exists(AutoConfig))lock(typeof(ReadingQuantowerBridge)) {
                if(autoTimer==null) {
                    autoHost=new ReadingQuantowerBridge(true);
                    autoTimer=new Timer(_=>AutoTick(),null,3000,5000);
                    AppDomain.CurrentDomain.ProcessExit+=(_,__)=>{autoTimer?.Dispose();autoHost?.CloseExport();};
                    Lifecycle("BACKGROUND_HOST_REGISTERED");
                }
            }
        }
        private ReadingQuantowerBridge(bool background) {
            backgroundHost=background;
            Name="READING - DATA ONLY";
            Description="Read-only CQG market-event recorder. No account or order access. Feed starts UNVERIFIED.";
            Lifecycle("CONSTRUCTED");
        }
        private static void AutoTick() {
            if(Interlocked.Exchange(ref autoBusy,1)!=0)return;
            try {
                if(!File.Exists(AutoConfig)){autoHost.CloseExport();return;}
                using var doc=JsonDocument.Parse(File.ReadAllText(AutoConfig));
                var cfg=doc.RootElement;
                bool enabled=cfg.TryGetProperty("enabled",out var value) && value.GetBoolean();
                if(!enabled || File.Exists(Path.Combine(autoHost.OutputDirectory,"STOP"))){autoHost.CloseExport();return;}
                if(!autoHost.closing && autoHost.writer!=null && autoHost.writer.IsAlive)return;
                autoHost.CloseExport();
                if(cfg.TryGetProperty("contracts",out value))autoHost.Contracts=value.GetString();
                if(cfg.TryGetProperty("connection_name",out value))autoHost.ConnectionName=value.GetString();
                if(cfg.TryGetProperty("export_depth",out value))autoHost.ExportDepth=value.GetBoolean();
                // Never silently promote an opted-in recorder to a verified LIVE feed.
                autoHost.FeedLabel="UNVERIFIED";
                if(Core.Instance.Connections.Connected.Any(c=>c.Name==autoHost.ConnectionName)) {
                    autoHost.StartExport();Lifecycle("BACKGROUND_EXPORT_STARTED");
                }
            }catch(Exception ex){Lifecycle("BACKGROUND_WAIT_OR_ERROR "+ex.GetType().Name+": "+ex.Message);autoHost.CloseExport();}
            finally{Volatile.Write(ref autoBusy,0);}
        }
        private static void Lifecycle(string state) {
            try {
                string folder=@"C:\Users\piard\Documents\Codex\2026-11-07\https-youtu-be-j-6bhln-d70\work\quantower_feed";
                Directory.CreateDirectory(folder);
                File.AppendAllText(Path.Combine(folder,"activation.log"),DateTime.UtcNow.ToString("O")+" "+state+Environment.NewLine);
            }catch{}
        }
        protected override void OnCreated() {Lifecycle("CREATED");}
        public override string[] MonitoringConnectionsIds => connection == null ? Array.Empty<string>() : new [] {connection.Id};

        protected override void OnRun() {
            Lifecycle("RUN_REQUESTED");
            try { StartExport(); }
            catch(Exception ex) { Log("READING startup failed: "+ex.Message,StrategyLoggingLevel.Error); CloseExport(); throw; }
        }
        private void StartExport() {
            if(writer != null && writer.IsAlive) throw new InvalidOperationException("Previous writer is still draining");
            string label=(FeedLabel??"").Trim().ToUpperInvariant();
            if(!new[]{"UNVERIFIED","LIVE","DELAYED","REPLAY"}.Contains(label)) throw new ArgumentException("Invalid feed label");
            FeedLabel=label;
            var wanted=(Contracts??"").Split(',').Select(x=>x.Trim().ToUpperInvariant()).Where(x=>x.Length>0).ToArray();
            if(wanted.Length==0 || wanted.Length>8 || wanted.Any(x=>!ContractPattern.IsMatch(x))) throw new ArgumentException("Use explicit standard CQG futures names, e.g. EU6Z26 (not EEU/M6E)");
            if(wanted.Select(x=>ContractPattern.Match(x).Groups[1].Value).Distinct().Count()!=wanted.Length) throw new ArgumentException("One expiry per root only");
            var candidates=Core.Instance.Connections.Connected.Where(c=>c.Name==ConnectionName && c.VendorName.IndexOf("CQG",StringComparison.OrdinalIgnoreCase)>=0).ToArray();
            if(candidates.Length!=1) throw new InvalidOperationException("Expected exactly one connected CQG connection named "+ConnectionName);
            connection=candidates[0];
            Directory.CreateDirectory(OutputDirectory);
            instanceLock=new FileStream(Path.Combine(OutputDirectory,"bridge.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
            ownsLock=true; session=Guid.NewGuid().ToString("N"); sequence=dropped=trades=quotes=depths=0;
            subscribed.Clear();identities.Clear();lastTrade.Clear();lastQuoteExport.Clear();quoteExports=0;failure=null;closing=false;
            queue=new BlockingCollection<string>(50000);
            writer=new Thread(WriteLoop){IsBackground=true,Name="ReadingDataWriter"};writer.Start();
            Emit("session_start",null,new Dictionary<string,object>{{"contracts",wanted},{"depth_requested",ExportDepth},{"live_verified",false}});
            connection.StateChanged+=ConnectionChanged;
            foreach(string name in wanted) {
                try {
                    Symbol s=Core.Instance.GetSymbol(new GetSymbolRequestParameters {SymbolId="F.US."+name},connection.Id);
                    if(s==null || s.ConnectionId!=connection.Id || s.Id!="F.US."+name || s.SymbolType!=SymbolType.Futures)
                        throw new InvalidOperationException("Exact CQG futures identity could not be resolved");
                    var m=ContractPattern.Match(name); string root=Roots[m.Groups[1].Value];
                    int month="FGHJKMNQUVXZ".IndexOf(m.Groups[2].Value,StringComparison.Ordinal)+1;
                    string normalized=root+" "+month.ToString("00",CultureInfo.InvariantCulture)+"-"+m.Groups[3].Value;
                    if(s.ExpirationDate.Year!=2000+int.Parse(m.Groups[3].Value,CultureInfo.InvariantCulture) || s.ExpirationDate.Month!=month)
                        throw new InvalidOperationException("Provider expiry does not match requested contract");
                    lock(gate) { identities[s]=Tuple.Create(root,normalized);subscribed.Add(s); }
                    Emit("subscription_requested",s,new Dictionary<string,object>{{"entitlement_verified",false},{"description",s.Description},{"expiration_raw",s.ExpirationDate.ToString("O")}});
                    s.NewLast+=OnLast; s.NewQuote+=OnQuote;
                    if(ExportDepth) s.NewLevel2+=OnDepth;
                } catch(Exception ex) {Emit("subscription_error",null,new Dictionary<string,object>{{"requested_symbol",name},{"error",ex.Message}});}
            }
            timer=new Timer(_=>Heartbeat(),null,0,2000);
            if(!backgroundHost)Log("READING data exporter running. Subscription requests do not prove live entitlement.");
            Lifecycle("EXPORTER_RUNNING_DATA_ONLY");
        }
        private void ConnectionChanged(object sender,ConnectionStateChangedEventArgs e) {
            Emit("reset",null,new Dictionary<string,object>{{"connection_state",e.NewState.ToString()}});
        }
        private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        private void OnLast(Symbol s,Last last) {
            if(closing)return;
            long stamp=Now();lock(gate)lastTrade[s.Id]=stamp;
            Interlocked.Increment(ref trades);
            // BBO is a callback-time snapshot, NOT exchange-synchronised BBO on this trade.
            Emit("trade",s,new Dictionary<string,object>{{"price",last.Price},{"volume",last.Size},
                {"bid",s.Bid},{"ask",s.Ask},{"aggressor_flag",last.AggressorFlag.ToString()},
                {"aggressor_origin","QUANTOWER_PROVIDER_FLAG_PROVENANCE_UNVERIFIED"},
                {"bbo_alignment","CALLBACK_SNAPSHOT_NOT_TRADE_SYNCHRONIZED"},
                {"platform_time_raw",last.Time.ToString("O")},{"platform_time_kind",last.Time.Kind.ToString()},
                {"timestamp_alignment_verified",false}},stamp);
        }
        private void OnQuote(Symbol s,Quote q) {
            Interlocked.Increment(ref quotes);
            long now=Now();lock(gate) {
                if(lastQuoteExport.TryGetValue(s.Id,out long previous) && now-previous<250)return;
                lastQuoteExport[s.Id]=now;
            }
            Interlocked.Increment(ref quoteExports);
            Emit("quote",s,new Dictionary<string,object>{{"bid",q.Bid},{"ask",q.Ask},{"bid_size",q.BidSize},{"ask_size",q.AskSize},
                {"platform_time_raw",q.Time.ToString("O")},{"platform_time_kind",q.Time.Kind.ToString()},{"timestamp_alignment_verified",false},
                {"quote_export_sampling_ms",250},{"sampling_scope","FUTURES_BBO_ONLY_ALL_TRADES_PRESERVED"}});
        }
        private void OnDepth(Symbol s,Level2Quote level,DOMQuote dom) {
            Interlocked.Increment(ref depths);
            if(level!=null) Emit("depth_delta",s,new Dictionary<string,object>{{"side",level.PriceType.ToString()},
                {"price",level.Price},{"volume",level.Size},{"closed",level.Closed},{"order_id_available",false},
                {"platform_time_raw",level.Time.ToString("O")},{"mbo_verified",false}});
            if(dom!=null) Emit("depth_snapshot",s,new Dictionary<string,object>{
                {"bids",dom.Bids?.Take(100).Select(x=>new[]{x.Price,x.Size}).ToArray()},
                {"asks",dom.Asks?.Take(100).Select(x=>new[]{x.Price,x.Size}).ToArray()},
                {"snapshot_cap_per_side",100},{"full_book_snapshot",false},{"order_id_available",false},{"mbo_verified",false}});
        }
        private void Heartbeat() {
            if(closing)return;
            try {
                var rows=new List<Dictionary<string,object>>();
                lock(gate)foreach(var s in subscribed) rows.Add(new Dictionary<string,object>{{"provider_symbol",s.Id},
                    {"root",identities[s].Item1},{"contract",identities[s].Item2},{"provider_delay_ms",s.QuoteDelay.TotalMilliseconds},
                    {"last_trade_received_ms",lastTrade.TryGetValue(s.Id,out long t)?(object)t:null}});
                Emit("heartbeat",null,new Dictionary<string,object>{{"dropped_total",Interlocked.Read(ref dropped)},
                    {"exporter_version","1.0.3"},{"storage_mode","ROTATING_64MIB_OR_5MIN"},{"quote_exports_total",Interlocked.Read(ref quoteExports)},
                    {"connection_state",connection.State.ToString()},{"symbols",rows},{"trades_total",Interlocked.Read(ref trades)},
                    {"quotes_total",Interlocked.Read(ref quotes)},{"depth_events_total",Interlocked.Read(ref depths)}});
            }catch(Exception ex){Fail(ex);}
        }
        private void Emit(string kind,Symbol symbol,Dictionary<string,object> fields,long? stamp=null) {
            lock(gate) {
                if(closing || queue==null || queue.IsAddingCompleted)return;
                var row=new Dictionary<string,object>{{"schema",1},{"source","QUANTOWER_DESKTOP"},{"session_id",session},
                    {"sequence",++sequence},{"received_utc_ms",Now()},{"kind",kind},{"feed_label",FeedLabel},
                    {"order_routing",false},{"connection_state",connection?.State.ToString()}};
                if(symbol!=null && identities.TryGetValue(symbol,out var id)) {
                    row["root"]=id.Item1;row["contract"]=id.Item2;row["provider_symbol"]=symbol.Id;
                    row["provider_delay_ms"]=symbol.QuoteDelay.TotalMilliseconds;
                }
                if(stamp.HasValue)row["callback_utc_ms"]=stamp.Value;
                if(fields!=null)foreach(var item in fields)row[item.Key]=item.Value;
                try { if(!queue.TryAdd(JsonSerializer.Serialize(row,JsonOptions)))Interlocked.Increment(ref dropped); }
                catch(Exception ex) {Fail(ex);}
            }
        }
        // NaN BBO values are explicit null, never bogus JSON numeric strings.
        private static readonly JsonSerializerOptions JsonOptions=CreateJsonOptions();
        private static JsonSerializerOptions CreateJsonOptions() {var o=new JsonSerializerOptions();o.Converters.Add(new FiniteDoubleConverter());return o;}
        private sealed class FiniteDoubleConverter : System.Text.Json.Serialization.JsonConverter<double> {
            public override double Read(ref Utf8JsonReader r,Type t,JsonSerializerOptions o)=>r.GetDouble();
            public override void Write(Utf8JsonWriter w,double v,JsonSerializerOptions o){if(double.IsFinite(v))w.WriteNumberValue(v);else w.WriteNullValue();}
        }
        private void WriteLoop() {
            RotatingJsonlSink output=new RotatingJsonlSink(OutputDirectory);long lastCheck=0,lastFlush=0;int batch=0;
            try {
                while(!queue.IsCompleted) {
                    if(!queue.TryTake(out string line,200)){output?.Flush();batch=0;continue;}
                    long now=Now();
                    if(now-lastCheck>=2000) {
                        long total=Directory.EnumerateFiles(OutputDirectory,"*.jsonl").Sum(p=>new FileInfo(p).Length);
                        if(new DriveInfo(Path.GetPathRoot(Path.GetFullPath(OutputDirectory))).AvailableFreeSpace<2L*1024*1024*1024 || total>=4L*1024*1024*1024)
                            throw new IOException("LOW_DISK_OR_TOTAL_STORAGE_LIMIT");
                        lastCheck=now;
                    }
                    output.WriteLine(line,now);if(++batch>=100 || now-lastFlush>=100){output.Flush();batch=0;lastFlush=now;}
                }
            } catch(Exception ex){Fail(ex);}
            finally{output?.Dispose();}
        }
        private void Fail(Exception ex) {
            failure=ex.GetType().Name+": "+ex.Message;closing=true;
            if(ownsLock)try{File.WriteAllText(Path.Combine(OutputDirectory,"EXPORT_FAILED.txt"),DateTime.UtcNow.ToString("O")+" "+failure);}catch{}
        }
        protected override List<StrategyMetric> OnGetMetrics() => new List<StrategyMetric> {
            new StrategyMetric{Name="Mode",FormattedValue="DATA ONLY / NO ORDERS"},
            new StrategyMetric{Name="State",FormattedValue=failure??(closing?"STOPPED":"EXPORTING (live unverified)")},
            new StrategyMetric{Name="Trade events",FormattedValue=Interlocked.Read(ref trades).ToString()},
            new StrategyMetric{Name="Quote events",FormattedValue=Interlocked.Read(ref quotes).ToString()},
            new StrategyMetric{Name="Dropped",FormattedValue=Interlocked.Read(ref dropped).ToString()}};
        protected override void OnStop()=>CloseExport();
        protected override void OnRemove()=>CloseExport();
        private void CloseExport() {
            timer?.Dispose();timer=null;
            if(connection!=null)connection.StateChanged-=ConnectionChanged;
            // Do not hold gate while removing provider callbacks.
            Symbol[] symbols;lock(gate)symbols=subscribed.ToArray();
            foreach(var s in symbols){s.NewLast-=OnLast;s.NewQuote-=OnQuote;if(ExportDepth)s.NewLevel2-=OnDepth;}
            Emit("session_stop",null,null);closing=true;
            lock(gate)if(queue!=null && !queue.IsAddingCompleted)queue.CompleteAdding();
            if(writer!=null && writer.IsAlive && !writer.Join(5000))return; // retain lock until drain, never start duplicate writer
            instanceLock?.Dispose();instanceLock=null;ownsLock=false;
        }
    }

    public sealed class RotatingJsonlSink : IDisposable {
        private readonly string folder;private readonly long maxBytes,maxAge;
        private StreamWriter writer;private string day;private long bytes,opened;
        public RotatingJsonlSink(string folder,long maxBytes=64L*1024*1024,long maxAge=300000) {
            this.folder=folder;this.maxBytes=maxBytes;this.maxAge=maxAge;Directory.CreateDirectory(folder);
        }
        public void WriteLine(string line,long now) {
            string currentDay=DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime.ToString("yyyy-MM-dd");
            long length=Encoding.UTF8.GetByteCount(line)+1;
            if(length>maxBytes)throw new IOException("SINGLE_EVENT_EXCEEDS_FRAGMENT_LIMIT");
            if(writer==null || day!=currentDay || bytes+length>maxBytes || now-opened>=maxAge) {
                writer?.Dispose();day=currentDay;
                string archive=Path.Combine(folder,"archive");
                var files=Directory.EnumerateFiles(folder,day+".part*.jsonl");
                if(Directory.Exists(archive))files=files.Concat(Directory.EnumerateFiles(archive,day+".part*.jsonl.gz"));
                int part=files.Select(p=>Regex.Match(Path.GetFileName(p),@"\.part(\d+)\.jsonl(?:\.gz)?$"))
                    .Where(m=>m.Success).Select(m=>int.Parse(m.Groups[1].Value,CultureInfo.InvariantCulture)).DefaultIfEmpty(-1).Max()+1;
                string path;
                do {path=Path.Combine(folder,day+".part"+(part++).ToString("D8",CultureInfo.InvariantCulture)+".jsonl");}while(File.Exists(path));
                writer=new StreamWriter(new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));
                writer.NewLine="\n";File.WriteAllText(Path.Combine(folder,"ACTIVE_FILE.txt"),Path.GetFileName(path));bytes=0;opened=now;
            }
            writer.WriteLine(line);bytes+=length;
        }
        public void Flush(){writer?.Flush();}
        public void Dispose(){writer?.Dispose();writer=null;}
    }
}
