using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Line = System.Windows.Shapes.Line;
using Microsoft.Win32;

namespace RevitLocalCodex
{
    // This window owns plain drawing data only. All Revit work is dispatched by the host queue.
    internal sealed class SchematicEditorWindow : Window
    {
        private const int MaxRequestBytes = 120 * 1024;
        private const int MaxResultCharacters = 250000;
        private const double NodeWidth = 156;
        private const double NodeHeight = 48;
        private readonly Func<string, Dictionary<string, object>, Task<Dictionary<string, object>>> _submit;
        private readonly string _documentPath;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = MaxResultCharacters };
        private readonly TextBox _startId = new TextBox();
        private readonly TextBox _nodeLabel = new TextBox();
        private readonly TextBlock _selectedInfo = new TextBlock();
        private readonly TextBlock _summary = new TextBlock();
        private readonly TextBlock _warnings = new TextBlock();
        private readonly TextBox _status = new TextBox();
        private readonly Canvas _canvas = new Canvas();
        private readonly ScrollViewer _scroll = new ScrollViewer();
        private readonly ScaleTransform _scale = new ScaleTransform(1, 1);
        private readonly List<Control> _requestControls = new List<Control>();
        private readonly List<Control> _drawingControls = new List<Control>();
        private readonly List<Control> _writeControls = new List<Control>();
        private readonly Dictionary<string, Border> _nodeVisuals = new Dictionary<string, Border>(StringComparer.Ordinal);
        private readonly List<Line> _edgeVisuals = new List<Line>();
        private SchematicModel _drawing;
        private SchematicModel _baseline;
        private string _selectedKey;
        private string _dragKey;
        private Point _dragMouse;
        private double _dragX;
        private double _dragY;
        private double _originX;
        private double _originY;
        private bool _busy;
        private bool _unknownOutcome;
        private bool _closed;
        private bool _hostClosing;
        private string _requestTrace = "";

        internal SchematicEditorWindow(
            Func<string, Dictionary<string, object>, Task<Dictionary<string, object>>> submit,
            string documentPath, long initialElementId)
        {
            if (submit == null) throw new ArgumentNullException("submit");
            if (String.IsNullOrWhiteSpace(documentPath)) throw new ArgumentException("需要已保存文档的完整路径。", "documentPath");
            _submit = submit;
            _documentPath = Path.GetFullPath(documentPath);
            Title = "BuildX · 系统图预览与编辑";
            Width = 1180;
            Height = 790;
            MinWidth = 860;
            MinHeight = 590;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            Background = Brush("#F3F5F5");
            FontFamily = new FontFamily("Microsoft YaHei UI");
            FontSize = 13;
            BuildWindow();
            if (initialElementId > 0) _startId.Text = initialElementId.ToString(CultureInfo.InvariantCulture);
            Closing += OnClosing;
            Closed += delegate { _closed = true; _dragKey = null; };
            Loaded += delegate
            {
                SetStatus("选择一个管线或设备起点，生成只读预览后可拖动节点、改文字，再验证或输出 Revit 详图。\r\n当前文档：" + _documentPath);
                UpdateControls();
            };
        }

        internal void CloseForHostShutdown()
        {
            _hostClosing = true;
            Close();
        }

        private static SolidColorBrush Brush(string color)
        {
            return (SolidColorBrush)new BrushConverter().ConvertFromString(color);
        }

        private void BuildWindow()
        {
            Grid root = new Grid { Margin = new Thickness(16), Background = Background };
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(116) });
            Content = root;

            StackPanel heading = new StackPanel { Margin = new Thickness(0, 0, 0, 12) };
            heading.Children.Add(new TextBlock { Text = "系统图工作台", FontSize = 22, FontWeight = FontWeights.SemiBold, Foreground = Brush("#203B36") });
            heading.Children.Add(new TextBlock
            {
                Text = "自研基础符号与连通布局 · 预览编辑不修改模型 · 输出详图不会自动保存文件",
                Foreground = Brush("#596B67"), Margin = new Thickness(0, 5, 0, 0), TextWrapping = TextWrapping.Wrap
            });
            root.Children.Add(heading);

            WrapPanel toolbar = new WrapPanel { Margin = new Thickness(0, 0, 0, 12), VerticalAlignment = VerticalAlignment.Center };
            toolbar.Children.Add(new TextBlock { Text = "起点元素 ID", VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 7) });
            _startId.Width = 145;
            _startId.Padding = new Thickness(7, 6, 7, 6);
            _startId.Margin = new Thickness(0, 0, 8, 7);
            _startId.ToolTip = "Revit 当前文档内的管线或设备元素 ID";
            toolbar.Children.Add(_startId);
            _requestControls.Add(_startId);
            Button preview = RequestButton("生成只读预览", Preview);
            toolbar.Children.Add(preview);
            _requestControls.Add(preview);
            AddDrawingButton(toolbar, "适合窗口", delegate { Fit(); });
            AddDrawingButton(toolbar, "−", delegate { Zoom(1 / 1.2); });
            AddDrawingButton(toolbar, "+", delegate { Zoom(1.2); });
            AddDrawingButton(toolbar, "重置编辑", delegate { ResetDrawing(); });
            AddDrawingButton(toolbar, "保存草稿", delegate { SaveDraft(); });
            AddDrawingButton(toolbar, "加载草稿", delegate { LoadDraft(); });
            Grid.SetRow(toolbar, 1);
            root.Children.Add(toolbar);

            Grid workspace = new Grid();
            workspace.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            workspace.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(280) });
            _canvas.Background = Brushes.White;
            _canvas.LayoutTransform = _scale;
            _canvas.Width = 600;
            _canvas.Height = 400;
            _scroll.Content = _canvas;
            _scroll.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
            _scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            _scroll.Background = Brushes.White;
            _scroll.BorderBrush = Brush("#D6DEDB");
            _scroll.BorderThickness = new Thickness(1);
            _scroll.PreviewMouseWheel += delegate(object sender, MouseWheelEventArgs e)
            {
                if ((Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
                {
                    Zoom(e.Delta > 0 ? 1.15 : 1 / 1.15);
                    e.Handled = true;
                }
            };
            workspace.Children.Add(_scroll);
            StackPanel side = new StackPanel { Margin = new Thickness(16, 0, 0, 0) };
            side.Children.Add(new TextBlock { Text = "预览信息", FontWeight = FontWeights.SemiBold, FontSize = 15 });
            _summary.Text = "尚未生成预览";
            _summary.TextWrapping = TextWrapping.Wrap;
            _summary.Margin = new Thickness(0, 8, 0, 15);
            side.Children.Add(_summary);
            side.Children.Add(new TextBlock { Text = "节点文字", FontWeight = FontWeights.SemiBold });
            _selectedInfo.Text = "点击节点选择；按住节点拖动位置。";
            _selectedInfo.TextWrapping = TextWrapping.Wrap;
            _selectedInfo.Margin = new Thickness(0, 6, 0, 7);
            side.Children.Add(_selectedInfo);
            _nodeLabel.TextWrapping = TextWrapping.Wrap;
            _nodeLabel.AcceptsReturn = true;
            _nodeLabel.Height = 76;
            _nodeLabel.MaxLength = 300;
            _nodeLabel.Padding = new Thickness(6);
            side.Children.Add(_nodeLabel);
            _drawingControls.Add(_nodeLabel);
            Button apply = Button("应用节点文字", delegate { ApplyLabel(); });
            apply.HorizontalAlignment = HorizontalAlignment.Left;
            apply.Margin = new Thickness(0, 7, 0, 14);
            side.Children.Add(apply);
            _drawingControls.Add(apply);
            side.Children.Add(new TextBlock { Text = "检查与输出", FontWeight = FontWeights.SemiBold });
            side.Children.Add(new TextBlock
            {
                Text = "回滚验证：创建、回读后由宿主回滚。\n生成详图：保留在当前文档，文件由你保存。",
                TextWrapping = TextWrapping.Wrap, Foreground = Brush("#596B67"), Margin = new Thickness(0, 6, 0, 8)
            });
            Button rollback = RequestButton("回滚验证（不保留）", delegate { return Export("rollback"); });
            Button commit = RequestButton("生成 Revit 详图", delegate { return Export("commit"); });
            rollback.HorizontalAlignment = HorizontalAlignment.Stretch;
            commit.HorizontalAlignment = HorizontalAlignment.Stretch;
            commit.Background = Brush("#23624F");
            commit.Foreground = Brushes.White;
            side.Children.Add(rollback);
            side.Children.Add(commit);
            _writeControls.Add(rollback);
            _writeControls.Add(commit);
            _warnings.TextWrapping = TextWrapping.Wrap;
            _warnings.Foreground = Brush("#8B5C24");
            _warnings.Margin = new Thickness(0, 12, 0, 0);
            ScrollViewer warningScroll = new ScrollViewer { Content = _warnings, MaxHeight = 130, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            side.Children.Add(warningScroll);
            ScrollViewer sideScroll = new ScrollViewer { Content = side, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            Grid.SetColumn(sideScroll, 1);
            workspace.Children.Add(sideScroll);
            Grid.SetRow(workspace, 2);
            root.Children.Add(workspace);

            _status.IsReadOnly = true;
            _status.AcceptsReturn = true;
            _status.TextWrapping = TextWrapping.Wrap;
            _status.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
            _status.Background = Brush("#E8EFEC");
            _status.BorderThickness = new Thickness(0);
            _status.Padding = new Thickness(10);
            _status.Margin = new Thickness(0, 12, 0, 0);
            Grid.SetRow(_status, 3);
            root.Children.Add(_status);
        }

        private Button Button(string text, Action action)
        {
            Button button = new Button { Content = text, Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 7, 7) };
            button.Click += delegate
            {
                if (_closed || _busy) return;
                try { action(); }
                catch (Exception ex) { SetStatus("操作未完成：" + ex.Message); }
            };
            return button;
        }

        private void AddDrawingButton(Panel panel, string text, Action action)
        {
            Button button = Button(text, action);
            panel.Children.Add(button);
            _drawingControls.Add(button);
        }

        private Button RequestButton(string text, Func<Task> operation)
        {
            Button button = new Button { Content = text, Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 7, 7) };
            button.Click += async delegate
            {
                if (_closed || _busy) return;
                try { await operation(); }
                catch (Exception ex) { if (!_closed) SetStatus("操作未完成：" + ex.Message); }
            };
            return button;
        }

        private async Task Preview()
        {
            long start;
            if (!Int64.TryParse(_startId.Text.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out start) || start <= 0)
                throw new InvalidOperationException("请输入正整数起点元素 ID。");
            await RunRequest(async delegate
            {
                SetStatus("正在从当前文档读取连通关系并生成预览；模型不会被修改。若网络较大，请等待本次结果。");
                Dictionary<string, object> response = await Send("preview_schematic", new Dictionary<string, object>
                {
                    { "expected_document", _documentPath }, { "start_element_id", start }
                });
                if (_closed) return;
                try
                {
                    SchematicModel model = ReadModel(Required(response, "value"));
                    SchematicModelRules.Validate(model);
                    if (!SamePath(model.documentPath, _documentPath) || model.rootElementId != start)
                        throw new InvalidOperationException("预览响应文档或起点身份不匹配。");
                    _baseline = Clone(model);
                    _drawing = Clone(model);
                    _selectedKey = null;
                    Draw(true);
                    Fit();
                    SetStatus("只读预览已生成：" + model.nodes.Count + " 个节点，" + model.edges.Count + " 条连线。可拖动节点、编辑文字，或保存本地草稿。\r\n尚未向 Revit 写入详图。");
                }
                catch (Exception ex) { MarkUnknown("预览响应结构或身份未通过核对。" + ex.Message); }
            });
        }

        private async Task Export(string mode)
        {
            if (_unknownOutcome) throw new InvalidOperationException("上次请求结果未知，核查队列结果后才能重新打开窗口进行写入。");
            if (_drawing == null) throw new InvalidOperationException("请先生成当前文档的预览。");
            if (mode != "rollback" && mode != "commit") throw new InvalidOperationException("无效的输出模式。");
            ApplyPendingLabel();
            SchematicModelRules.Validate(_drawing);
            CheckIdentity(_baseline, _drawing);
            SchematicModel snapshot = Clone(_drawing);
            await RunRequest(async delegate
            {
                SetStatus(mode == "rollback" ? "正在创建并回读详图；宿主完成后将回滚本次创建。请等待最终事务结果。" : "正在生成 Revit 详图并回读结果。完成后详图保留在当前文档，不自动保存文件。");
                Dictionary<string, object> response = await Send("export_schematic", new Dictionary<string, object>
                {
                    { "expected_document", _documentPath }, { "mode", mode }, { "drawing", snapshot }
                });
                if (_closed) return;
                try
                {
                    if (!(Required(response, "mode") is string) || (string)response["mode"] != mode || !(Required(response, "committed") is bool) || (bool)response["committed"] != (mode == "commit"))
                        throw new InvalidOperationException("宿主事务结果与请求模式不一致。");
                    Dictionary<string, object> value = AsDictionary(Required(response, "value"));
                    long viewId = PositiveInteger(Required(value, "view_id"));
                    string viewName = Required(value, "view_name") as string;
                    if (String.IsNullOrWhiteSpace(viewName)) throw new InvalidOperationException("缺少实际视图名称。");
                    long nodes = PositiveInteger(Required(value, "actual_node_count"));
                    long edges = NonnegativeInteger(Required(value, "edge_line_count"));
                    long texts = NonnegativeInteger(Required(value, "text_count"));
                    long curves = NonnegativeInteger(Required(value, "detail_curve_count"));
                    if (nodes != snapshot.nodes.Count || edges != snapshot.edges.Count || texts != nodes || curves < edges)
                        throw new InvalidOperationException("回读的节点、连线或文字数量不符合当前预览。");
                    if (!String.Equals(Required(value, "symbol_style") as string, "basic-native-symbols", StringComparison.Ordinal))
                        throw new InvalidOperationException("未识别实际绘图符号契约。");
                    if (!String.Equals(Required(value, "layout_note") as string, "layout_bfs_not_engineering_analysis", StringComparison.Ordinal))
                        throw new InvalidOperationException("缺少连通示意与工程分析的能力说明。");
                    List<long> ids = ReadElementIds(Required(value, "element_ids"));
                    if (ids.Count != texts + curves) throw new InvalidOperationException("实际元素 ID 数量与回读计数不符。");
                    SetStatus((mode == "rollback" ? "回滚验证完成：已创建并回读，宿主确认本次事务已回滚。" : "详图已生成：宿主确认已提交到当前文档。请自行保存 Revit 文件。") +
                        "\r\n视图：" + viewName + "（ID " + viewId + "） · 节点 " + nodes + " · 连线 " + edges + " · 图元 " + ids.Count +
                        "\r\n" + (mode == "rollback" ? "回滚前实际图元 ID（用于核查，回滚后不再保留）：" : "实际图元 ID：") + String.Join(", ", ids.Select(id => id.ToString(CultureInfo.InvariantCulture))));
                }
                catch (Exception ex) { MarkUnknown("收到输出响应，但无法确认最终模型结果。" + ex.Message); }
            });
        }

        private async Task RunRequest(Func<Task> operation)
        {
            _busy = true;
            _dragKey = null;
            _canvas.ReleaseMouseCapture();
            UpdateControls();
            try { await operation(); }
            catch (UnknownWorkbenchOutcomeException ex) { if (!_closed) MarkUnknown(ex.Message); }
            catch (Exception ex) { if (!_closed) SetStatus("请求未完成：" + ex.Message + "\r\n未将本次请求报告为成功；请以宿主回执为准。"); }
            finally
            {
                _busy = false;
                if (!_closed) UpdateControls();
            }
        }

        private async Task<Dictionary<string, object>> Send(string operation, Dictionary<string, object> args)
        {
            _requestTrace = "";
            string request = _json.Serialize(new Dictionary<string, object> { { "operation", operation }, { "args", args } });
            if (Encoding.UTF8.GetByteCount(request) > MaxRequestBytes) throw new InvalidOperationException("当前请求超过 120 KiB，请缩小网络或缩短节点文字。");
            Dictionary<string, object> result = await _submit(operation, args);
            if (_closed) return null;
            object requestId;
            object responsePath;
            if (result != null && result.TryGetValue("_workbench_request_id", out requestId) && requestId is string &&
                result.TryGetValue("_workbench_response_path", out responsePath) && responsePath is string)
                _requestTrace = "\r\n请求 ID：" + (string)requestId + "\r\n队列回执：" + (string)responsePath;
            return result;
        }

        private void MarkUnknown(string detail)
        {
            _unknownOutcome = true;
            SetStatus("请求结果未知，已禁止本窗口再次写入，避免重复生成。\r\n" + detail + _requestTrace + "\r\n请核查该请求的队列回执与模型实际状态；不要立即重试。窗口可以关闭。");
            UpdateControls();
        }

        private void OnClosing(object sender, CancelEventArgs e)
        {
            if (_busy && !_hostClosing)
            {
                e.Cancel = true;
                SetStatus("当前请求仍在执行，请等待最终回执后再关闭窗口。关闭窗口不会撤销已经被宿主认领的任务。");
            }
        }

        private void UpdateControls()
        {
            if (_closed) return;
            foreach (Control control in _requestControls) control.IsEnabled = !_busy && !_unknownOutcome;
            foreach (Control control in _drawingControls) control.IsEnabled = !_busy && _drawing != null;
            foreach (Control control in _writeControls) control.IsEnabled = !_busy && !_unknownOutcome && _drawing != null;
            _canvas.IsHitTestVisible = !_busy;
            Cursor = _busy ? Cursors.Wait : Cursors.Arrow;
        }

        private void SetStatus(string text)
        {
            if (_closed) return;
            _status.Text = text;
            _status.ScrollToHome();
        }

        private void Draw(bool recalculateBounds)
        {
            if (_drawing == null || _closed) return;
            _canvas.Children.Clear();
            _nodeVisuals.Clear();
            _edgeVisuals.Clear();
            if (recalculateBounds)
            {
                _originX = 100 - _drawing.nodes.Min(n => n.x);
                _originY = 80 - _drawing.nodes.Min(n => n.y);
                _canvas.Width = Math.Max(600, _drawing.nodes.Max(n => n.x) + _originX + NodeWidth / 2 + 100);
                _canvas.Height = Math.Max(400, _drawing.nodes.Max(n => n.y) + _originY + NodeHeight / 2 + 90);
            }
            foreach (SchematicEdge edge in _drawing.edges)
            {
                Line line = new Line { Stroke = Brush("#6C8980"), StrokeThickness = 2, IsHitTestVisible = false };
                _edgeVisuals.Add(line);
                _canvas.Children.Add(line);
            }
            foreach (SchematicNode node in _drawing.nodes)
            {
                Border visual = new Border
                {
                    Width = NodeWidth, Height = NodeHeight, CornerRadius = new CornerRadius(5),
                    Background = Brush("#F0F6F3"), BorderBrush = Brush("#749A8C"), BorderThickness = new Thickness(1.5),
                    Padding = new Thickness(7, 4, 7, 4), Tag = node.key, Cursor = Cursors.SizeAll,
                    ToolTip = node.category + " · 元素 " + node.elementId.ToString(CultureInfo.InvariantCulture)
                };
                StackPanel content = new StackPanel();
                content.Children.Add(new TextBlock { Text = node.label, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, MaxHeight = 21 });
                content.Children.Add(new TextBlock { Text = "ID " + node.elementId.ToString(CultureInfo.InvariantCulture), FontSize = 10, Foreground = Brush("#62766D") });
                visual.Child = content;
                visual.MouseLeftButtonDown += NodeDown;
                visual.MouseMove += NodeMove;
                visual.MouseLeftButtonUp += NodeUp;
                visual.LostMouseCapture += delegate { _dragKey = null; };
                _nodeVisuals.Add(node.key, visual);
                _canvas.Children.Add(visual);
            }
            UpdatePositions();
            SelectNode(_selectedKey);
            _summary.Text = String.Format(CultureInfo.InvariantCulture, "{0} 个节点 · {1} 条连线\n起点 ID：{2}\n缩放：{3:0}%\n拖动仅改变系统图位置。", _drawing.nodes.Count, _drawing.edges.Count, _drawing.rootElementId, _scale.ScaleX * 100);
            _warnings.Text = "基础符号为自研示意；连通布局不代表水力计算或工程校核。" + ((_drawing.warnings != null && _drawing.warnings.Count > 0) ? "\n\n" + String.Join("\n", _drawing.warnings) : "");
            UpdateControls();
        }

        private void UpdatePositions()
        {
            if (_drawing == null) return;
            Dictionary<string, SchematicNode> nodes = _drawing.nodes.ToDictionary(n => n.key, StringComparer.Ordinal);
            foreach (SchematicNode node in _drawing.nodes)
            {
                Border visual = _nodeVisuals[node.key];
                Canvas.SetLeft(visual, node.x + _originX - NodeWidth / 2);
                Canvas.SetTop(visual, node.y + _originY - NodeHeight / 2);
            }
            for (int i = 0; i < _drawing.edges.Count; i++)
            {
                SchematicEdge edge = _drawing.edges[i];
                Line line = _edgeVisuals[i];
                line.X1 = nodes[edge.source].x + _originX;
                line.Y1 = nodes[edge.source].y + _originY;
                line.X2 = nodes[edge.target].x + _originX;
                line.Y2 = nodes[edge.target].y + _originY;
            }
        }

        private void NodeDown(object sender, MouseButtonEventArgs e)
        {
            if (_busy || _drawing == null) return;
            try { ApplyPendingLabel(); }
            catch (Exception ex) { SetStatus("节点文字未通过检查：" + ex.Message); e.Handled = true; return; }
            Border visual = (Border)sender;
            string key = (string)visual.Tag;
            SelectNode(key);
            SchematicNode node = _drawing.nodes.First(n => n.key == key);
            _dragKey = key;
            _dragMouse = e.GetPosition(_canvas);
            _dragX = node.x;
            _dragY = node.y;
            visual.CaptureMouse();
            e.Handled = true;
        }

        private void NodeMove(object sender, MouseEventArgs e)
        {
            if (_busy || _dragKey == null || e.LeftButton != MouseButtonState.Pressed) return;
            Point mouse = e.GetPosition(_canvas);
            SchematicNode node = _drawing.nodes.First(n => n.key == _dragKey);
            double nextX = _dragX + mouse.X - _dragMouse.X;
            double nextY = _dragY + mouse.Y - _dragMouse.Y;
            // Keep nodes reachable while scrolling. No Revit geometry is changed here.
            node.x = Math.Max(NodeWidth / 2 - _originX + 8, Math.Min(_canvas.Width - NodeWidth / 2 - _originX - 8, nextX));
            node.y = Math.Max(NodeHeight / 2 - _originY + 8, Math.Min(_canvas.Height - NodeHeight / 2 - _originY - 8, nextY));
            UpdatePositions();
            e.Handled = true;
        }

        private void NodeUp(object sender, MouseButtonEventArgs e)
        {
            _dragKey = null;
            ((Border)sender).ReleaseMouseCapture();
            e.Handled = true;
        }

        private void SelectNode(string key)
        {
            _selectedKey = key;
            foreach (KeyValuePair<string, Border> pair in _nodeVisuals)
            {
                pair.Value.BorderBrush = Brush(pair.Key == key ? "#145D45" : "#749A8C");
                pair.Value.BorderThickness = new Thickness(pair.Key == key ? 3 : 1.5);
            }
            SchematicNode node = _drawing == null ? null : _drawing.nodes.FirstOrDefault(n => n.key == key);
            _nodeLabel.Text = node == null ? "" : node.label;
            _selectedInfo.Text = node == null ? "点击节点选择；按住节点拖动位置。" : node.category + "\n元素 ID " + node.elementId.ToString(CultureInfo.InvariantCulture);
        }

        private void ApplyPendingLabel()
        {
            if (_drawing == null || _selectedKey == null) return;
            SchematicNode node = _drawing.nodes.FirstOrDefault(n => n.key == _selectedKey);
            if (node == null) return;
            string previous = node.label;
            node.label = _nodeLabel.Text.Trim();
            try { SchematicModelRules.Validate(_drawing); }
            catch { node.label = previous; throw; }
        }

        private void ApplyLabel()
        {
            if (_selectedKey == null) throw new InvalidOperationException("请先选择一个节点。");
            ApplyPendingLabel();
            Draw(false);
            SetStatus("已更新预览节点文字；尚未写入 Revit。");
        }

        private void ResetDrawing()
        {
            if (_baseline == null) return;
            _drawing = Clone(_baseline);
            _selectedKey = null;
            Draw(true);
            Fit();
            SetStatus("已恢复本次读取的原始预览布局与文字；模型未修改。");
        }

        private void Zoom(double factor)
        {
            if (_drawing == null) return;
            double scale = Math.Max(0.0001, Math.Min(4, _scale.ScaleX * factor));
            _scale.ScaleX = scale;
            _scale.ScaleY = scale;
            _summary.Text = String.Format(CultureInfo.InvariantCulture, "{0} 个节点 · {1} 条连线\n起点 ID：{2}\n缩放：{3:0}%\n拖动仅改变系统图位置。", _drawing.nodes.Count, _drawing.edges.Count, _drawing.rootElementId, scale * 100);
        }

        private void Fit()
        {
            if (_drawing == null) return;
            double width = Math.Max(100, _scroll.ActualWidth - 22);
            double height = Math.Max(100, _scroll.ActualHeight - 22);
            _scale.ScaleX = _scale.ScaleY = Math.Max(0.0001, Math.Min(1.5, Math.Min(width / _canvas.Width, height / _canvas.Height)));
            _scroll.ScrollToHorizontalOffset(0);
            _scroll.ScrollToVerticalOffset(0);
            Zoom(1);
        }

        private void SaveDraft()
        {
            if (_drawing == null) throw new InvalidOperationException("请先生成当前文档的预览。");
            ApplyPendingLabel();
            SchematicModelRules.Validate(_drawing);
            CheckIdentity(_baseline, _drawing);
            string json = _json.Serialize(new Dictionary<string, object>
            {
                { "format", "BuildX.schematic-draft/v1" }, { "savedUtc", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) }, { "drawing", _drawing }
            });
            if (Encoding.UTF8.GetByteCount(json) > MaxRequestBytes) throw new InvalidOperationException("草稿超过 120 KiB，请缩小网络或缩短文字。");
            SaveFileDialog dialog = new SaveFileDialog { Filter = "BuildX 系统图草稿 (*.json)|*.json", FileName = "BuildX-Schematic-" + _drawing.rootElementId.ToString(CultureInfo.InvariantCulture) + ".json", AddExtension = true, DefaultExt = ".json" };
            if (dialog.ShowDialog(this) != true) return;
            File.WriteAllText(dialog.FileName, json, new UTF8Encoding(false));
            SetStatus("系统图草稿已保存：" + dialog.FileName + "\r\n草稿只保存布局与说明数据；Revit 模型未修改。");
        }

        private void LoadDraft()
        {
            if (_drawing == null || _baseline == null) throw new InvalidOperationException("加载草稿前，请先成功生成当前文档、同一起点的预览。");
            OpenFileDialog dialog = new OpenFileDialog { Filter = "BuildX 系统图草稿 (*.json)|*.json", Multiselect = false };
            if (dialog.ShowDialog(this) != true) return;
            Dictionary<string, object> envelope = AsDictionary(_json.DeserializeObject(ReadDraftText(dialog.FileName)));
            if (!String.Equals(Required(envelope, "format") as string, "BuildX.schematic-draft/v1", StringComparison.Ordinal))
                throw new InvalidOperationException("不是受支持的 BuildX 系统图草稿。");
            SchematicModel imported = ReadModel(Required(envelope, "drawing"));
            SchematicModelRules.Validate(imported);
            CheckIdentity(_baseline, imported);
            SchematicModel edited = Clone(_drawing);
            Dictionary<string, SchematicNode> importedNodes = imported.nodes.ToDictionary(n => n.key, StringComparer.Ordinal);
            foreach (SchematicNode node in edited.nodes)
            {
                SchematicNode source = importedNodes[node.key];
                node.x = source.x;
                node.y = source.y;
                node.label = source.label;
            }
            SchematicModelRules.Validate(edited);
            _drawing = edited;
            _selectedKey = null;
            Draw(true);
            Fit();
            SetStatus("草稿身份和网络结构核对通过，只载入了节点位置与文字。\r\n" + dialog.FileName + "\r\nRevit 模型未修改。");
        }

        private static string ReadDraftText(string path)
        {
            // Bound the read itself as well as the reported file size; reject a growing/replaced file.
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length > MaxRequestBytes) throw new InvalidOperationException("草稿超过 120 KiB，未加载。");
                byte[] buffer = new byte[MaxRequestBytes + 1];
                int count = 0;
                int read;
                while (count < buffer.Length && (read = stream.Read(buffer, count, buffer.Length - count)) > 0) count += read;
                if (count > MaxRequestBytes) throw new InvalidOperationException("草稿超过 120 KiB，未加载。");
                int offset = count >= 3 && buffer[0] == 0xEF && buffer[1] == 0xBB && buffer[2] == 0xBF ? 3 : 0;
                return new UTF8Encoding(false, true).GetString(buffer, offset, count - offset);
            }
        }

        private static void CheckIdentity(SchematicModel expected, SchematicModel actual)
        {
            if (expected == null || actual == null || expected.schemaVersion != actual.schemaVersion || !SamePath(expected.documentPath, actual.documentPath) ||
                !String.Equals(expected.documentFingerprint, actual.documentFingerprint, StringComparison.Ordinal) || expected.rootElementId != actual.rootElementId ||
                !String.Equals(expected.rootUniqueId, actual.rootUniqueId, StringComparison.Ordinal) || expected.nodes.Count != actual.nodes.Count || expected.edges.Count != actual.edges.Count)
                throw new InvalidOperationException("草稿与当前文档、起点或网络身份不匹配，请重新读取对应模型。");
            Dictionary<string, SchematicNode> nodes = expected.nodes.ToDictionary(n => n.key, StringComparer.Ordinal);
            foreach (SchematicNode node in actual.nodes)
            {
                SchematicNode original;
                if (!nodes.TryGetValue(node.key, out original) || original.elementId != node.elementId || !String.Equals(original.uniqueId, node.uniqueId, StringComparison.Ordinal) || !String.Equals(original.category, node.category, StringComparison.Ordinal))
                    throw new InvalidOperationException("草稿改变了节点身份或类别，未加载。");
            }
            HashSet<string> edges = new HashSet<string>(expected.edges.Select(EdgeIdentity), StringComparer.Ordinal);
            if (edges.Count != expected.edges.Count || !edges.SetEquals(actual.edges.Select(EdgeIdentity)))
                throw new InvalidOperationException("草稿改变了网络连线结构，未加载。");
        }

        private static string EdgeIdentity(SchematicEdge edge)
        {
            return edge.source.Length.ToString(CultureInfo.InvariantCulture) + ":" + edge.source + edge.target;
        }

        private static bool SamePath(string first, string second)
        {
            return !String.IsNullOrWhiteSpace(first) && !String.IsNullOrWhiteSpace(second) && String.Equals(Path.GetFullPath(first), Path.GetFullPath(second), StringComparison.OrdinalIgnoreCase);
        }

        private SchematicModel ReadModel(object value)
        {
            return SchematicModelRules.Parse(value);
        }

        private SchematicModel Clone(SchematicModel model)
        {
            return _json.Deserialize<SchematicModel>(_json.Serialize(model));
        }

        private static object Required(Dictionary<string, object> dictionary, string key)
        {
            object value;
            if (dictionary == null || !dictionary.TryGetValue(key, out value) || value == null) throw new InvalidOperationException("响应缺少字段：" + key);
            return value;
        }

        private static Dictionary<string, object> AsDictionary(object value)
        {
            Dictionary<string, object> dictionary = value as Dictionary<string, object>;
            if (dictionary == null) throw new InvalidOperationException("数据不是有效对象。");
            return dictionary;
        }

        private static long NonnegativeInteger(object value)
        {
            // Accept JSON numeric tokens only; numeric strings and rounded fractions cannot establish an actual ID/count.
            if (!(value is byte || value is short || value is int || value is long || value is decimal || value is double || value is float))
                throw new InvalidOperationException("响应的 ID 或计数不是数字。");
            decimal number;
            try { number = Convert.ToDecimal(value, CultureInfo.InvariantCulture); }
            catch (Exception) { throw new InvalidOperationException("响应的 ID 或计数无效。"); }
            if (number < 0 || number > Int64.MaxValue || Decimal.Truncate(number) != number) throw new InvalidOperationException("响应的 ID 或计数不是非负整数。");
            return Decimal.ToInt64(number);
        }

        private static long PositiveInteger(object value)
        {
            long number = NonnegativeInteger(value);
            if (number == 0) throw new InvalidOperationException("响应的 ID 或计数必须大于零。");
            return number;
        }

        private static List<long> ReadElementIds(object value)
        {
            IEnumerable list = value as IEnumerable;
            if (list == null || value is string) throw new InvalidOperationException("缺少实际图元 ID 数组。");
            List<long> ids = new List<long>();
            HashSet<long> unique = new HashSet<long>();
            foreach (object item in list)
            {
                long id = PositiveInteger(item);
                if (!unique.Add(id)) throw new InvalidOperationException("实际图元 ID 数组存在重复。");
                ids.Add(id);
                if (ids.Count > SchematicModelRules.MaxEdges + SchematicModelRules.MaxNodes * 8) throw new InvalidOperationException("实际图元 ID 数量异常。");
            }
            if (ids.Count == 0) throw new InvalidOperationException("没有实际创建的图元 ID。");
            return ids;
        }
    }
}
