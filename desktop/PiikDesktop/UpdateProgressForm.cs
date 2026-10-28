using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PiikDesktop
{
    internal sealed class UpdateProgressForm : Form
    {
        private readonly Label _status;
        private readonly ProgressBar _progress;
        private readonly Button _cancel;
        private readonly string _prefix;
        private readonly Func<IProgress<DownloadProgress>, CancellationToken, Task<string>> _download;
        private readonly CancellationTokenSource _cancellation = new CancellationTokenSource();
        private bool _finished;

        public string DownloadedPath { get; private set; }
        public Exception Error { get; private set; }
        public IProgress<DownloadProgress> Reporter { get; }

        public UpdateProgressForm(Version version, Func<IProgress<DownloadProgress>, CancellationToken, Task<string>> download)
        {
            _download = download;
            _prefix = "正在下载新版本 v" + version.ToString(3);
            DownloadedPath = "";
            Text = "Piik-RTC 更新";
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(243, 245, 248);
            ClientSize = new Size(460, 154);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            AutoScaleMode = AutoScaleMode.Dpi;

            _status = new Label
            {
                AutoSize = false,
                Location = new Point(22, 20),
                Size = new Size(416, 42),
                Text = _prefix + "…",
                ForeColor = Color.FromArgb(42, 48, 58),
            };
            _progress = new ProgressBar
            {
                Location = new Point(22, 72),
                Size = new Size(416, 16),
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 28,
            };
            _cancel = new Button
            {
                Text = "取消",
                Location = new Point(358, 108),
                Size = new Size(80, 30),
                FlatStyle = FlatStyle.System,
                DialogResult = DialogResult.Cancel,
            };
            _cancel.Click += (_, __) => CancelDownload();

            Controls.Add(_status);
            Controls.Add(_progress);
            Controls.Add(_cancel);
            Reporter = new System.Progress<DownloadProgress>(Report);
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try
            {
                DownloadedPath = await _download(Reporter, _cancellation.Token);
                _finished = true;
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (OperationCanceledException)
            {
                _finished = true;
                DialogResult = DialogResult.Cancel;
                Close();
            }
            catch (Exception exception)
            {
                Error = exception;
                _finished = true;
                DialogResult = DialogResult.Abort;
                Close();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_finished)
            {
                e.Cancel = true;
                CancelDownload();
                return;
            }
            base.OnFormClosing(e);
        }

        private void CancelDownload()
        {
            if (_finished) return;
            _cancel.Enabled = false;
            _status.Text = "正在取消…";
            try { _cancellation.Cancel(); } catch { }
        }

        private void Report(DownloadProgress progress)
        {
            if (IsDisposed) return;
            if (progress.Percent < 0)
            {
                _progress.Style = ProgressBarStyle.Marquee;
                _status.Text = _prefix + "…";
                return;
            }
            if (_progress.Style != ProgressBarStyle.Continuous) _progress.Style = ProgressBarStyle.Continuous;
            _progress.Value = Math.Max(0, Math.Min(100, progress.Percent));
            var speed = FormatSpeed(progress.BytesPerSecond);
            _status.Text = _prefix + "… " + _progress.Value + "%" + (speed.Length == 0 ? "" : " · " + speed);
        }

        private static string FormatSpeed(long bytesPerSecond)
        {
            if (bytesPerSecond <= 0) return "";
            if (bytesPerSecond >= 1024 * 1024) return (bytesPerSecond / (1024.0 * 1024.0)).ToString("0.0") + " MB/s";
            return Math.Max(1, bytesPerSecond / 1024) + " KB/s";
        }
    }
}
