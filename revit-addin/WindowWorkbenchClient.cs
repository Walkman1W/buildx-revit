using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace RevitLocalCodex
{
    internal sealed class UnknownWorkbenchOutcomeException : Exception
    {
        internal string RequestId { get; private set; }
        internal UnknownWorkbenchOutcomeException(string id, string message, Exception inner = null)
            : base(message + " 请求 ID：" + id + "。请核对工作台回执，勿重复提交未知写入。", inner) { RequestId = id; }
    }

    // A second producer of the existing queue, never a second Revit dispatcher.
    // This class only accesses files and awaits asynchronously; it has no Revit API references.
    internal sealed class WindowWorkbenchClient : IDisposable
    {
        private readonly string queue;
        private readonly string session;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 40 };
        private readonly TimeSpan timeout;
        private bool pending;
        private bool disposed;
        private bool unknownOutcome;

        internal WindowWorkbenchClient(string root, string sessionId) : this(root, sessionId, TimeSpan.FromSeconds(120)) { }
        internal WindowWorkbenchClient(string root, string sessionId, TimeSpan requestTimeout)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || requestTimeout <= TimeSpan.Zero) throw new ArgumentException("Invalid workbench identity or timeout.");
            queue = Path.Combine(root, "queue");
            session = sessionId;
            timeout = requestTimeout;
        }

        internal async Task<Dictionary<string, object>> SubmitAsync(string operation, Dictionary<string, object> args)
        {
            if (disposed) throw new ObjectDisposedException("WindowWorkbenchClient");
            if (pending || unknownOutcome) throw new InvalidOperationException("已有操作进行中或其结果未知，请先核对回执。");
            if (operation != "preview_schematic" && operation != "export_schematic") throw new InvalidOperationException("Unsupported window operation.");
            if (args == null) throw new ArgumentNullException("args");
            string id = Guid.NewGuid().ToString();
            string inbox = Path.Combine(queue, "inbox", id + ".json");
            string temp = inbox + ".tmp";
            bool published = false;
            pending = true;
            try
            {
                RequireSession();
                var request = new Dictionary<string, object> {
                    { "id", id }, { "targetSession", session }, { "operation", operation }, { "args", args },
                    { "expiresUtc", DateTime.UtcNow.Add(timeout).ToString("o") }
                };
                byte[] payload = new UTF8Encoding(false).GetBytes(json.Serialize(request));
                if (payload.Length > 120 * 1024) throw new InvalidOperationException("系统图请求超过 120 KiB，请缩小网络或文字内容。");
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    stream.Write(payload, 0, payload.Length);
                File.Move(temp, inbox);
                published = true;
                var watch = Stopwatch.StartNew();
                string outbox = Path.Combine(queue, "outbox", id + ".json");
                while (true)
                {
                    if (disposed) throw new UnknownWorkbenchOutcomeException(id, "窗口已关闭；队列操作的结果未读取。");
                    if (File.Exists(outbox))
                    {
                        if (new FileInfo(outbox).Length > 1024 * 1024) throw new UnknownWorkbenchOutcomeException(id, "回执超过允许大小。");
                        var response = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(outbox));
                        object responseId, ok;
                        if (!response.TryGetValue("id", out responseId) || !string.Equals(Convert.ToString(responseId), id, StringComparison.Ordinal)
                            || !response.TryGetValue("ok", out ok) || !(ok is bool))
                            throw new UnknownWorkbenchOutcomeException(id, "工作台回执身份或结构不符。");
                        if (!(bool)ok)
                        {
                            var failure = response.ContainsKey("error") ? response["error"] as Dictionary<string, object> : null;
                            if (failure == null || !failure.ContainsKey("message")) throw new UnknownWorkbenchOutcomeException(id, "工作台失败回执不完整。");
                            // A terminal host error is distinct from transport failure.
                            published = false;
                            throw new InvalidOperationException(Convert.ToString(failure["message"]));
                        }
                        var result = response.ContainsKey("result") ? response["result"] as Dictionary<string, object> : null;
                        if (result == null || !result.ContainsKey("operation") || Convert.ToString(result["operation"]) != operation || !result.ContainsKey("value"))
                            throw new UnknownWorkbenchOutcomeException(id, "工作台结果契约不完整。");
                        if (operation == "export_schematic")
                        {
                            object committed, mode;
                            string requestedMode = args.ContainsKey("mode") ? Convert.ToString(args["mode"]) : "rollback";
                            if (!result.TryGetValue("committed", out committed) || !(committed is bool) || !result.TryGetValue("mode", out mode)
                                || Convert.ToString(mode) != requestedMode || (bool)committed != (requestedMode == "commit"))
                                throw new UnknownWorkbenchOutcomeException(id, "工作台写入完成状态不符。");
                        }
                        result["_workbench_request_id"] = id;
                        result["_workbench_response_path"] = outbox;
                        return result;
                    }
                    if (watch.Elapsed >= timeout) throw new UnknownWorkbenchOutcomeException(id, "等待回执超时；这不会中止已执行的 Revit 操作。");
                    await Task.Delay(200);
                }
            }
            catch (UnknownWorkbenchOutcomeException) { unknownOutcome = true; throw; }
            catch (Exception error)
            {
                if (published)
                {
                    unknownOutcome = true;
                    throw new UnknownWorkbenchOutcomeException(id, "请求发布后无法确定执行结果。", error);
                }
                throw;
            }
            finally
            {
                pending = false;
                // Only this invocation's unpublished staging file may be removed.
                // Claimed requests and all outcomes are retained as evidence.
                if (File.Exists(temp)) File.Delete(temp);
            }
        }

        private void RequireSession()
        {
            var host = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(queue, "host.json")));
            if (!host.ContainsKey("sessionId") || Convert.ToString(host["sessionId"]) != session)
                throw new InvalidOperationException("Revit 工作台会话已改变，请关闭并重新打开系统图窗口。");
        }

        public void Dispose() { disposed = true; }
    }
}
