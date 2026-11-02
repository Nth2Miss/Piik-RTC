using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PiikDesktop
{
    internal static class Win32
    {
        public const int GwlExStyle = -20;
        public const long WsExToolWindow = 0x00000080;
        public const int DwmwaCloaked = 14;
        public const int PwRenderFullContent = 2;
        public const int WmNull = 0x0000;
        public const int SmtoAbortIfHung = 0x0002;
        public const uint SwpNosize = 0x0001;
        public const uint SwpNomove = 0x0002;
        public const uint SwpNozorder = 0x0004;
        public const uint SwpNoactivate = 0x0010;
        public const uint SwpNoSendChanging = 0x0400;
        public const int SwMinimize = 6;
        public const int SwShowNoActivate = 4;
        public const int WsPopup = unchecked((int)0x80000000);
        public const int SsBlackRect = 0x00000004;
        public const int WsExNoActivate = 0x08000000;
        public const uint SwpShowWindow = 0x0040;
        public const int DwmTnRectDestination = 0x00000001;
        public const int DwmTnOpacity = 0x00000004;
        public const int DwmTnVisible = 0x00000008;
        public const int DwmTnSourceClientAreaOnly = 0x00000010;

        public delegate bool EnumWindowsProc(IntPtr window, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool IsHungAppWindow(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeout(IntPtr window, int message, IntPtr wParam, IntPtr lParam, int flags, uint timeout, out IntPtr result);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint thread, uint attachTo, bool attach);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("dwmapi.dll")]
        public static extern int DwmFlush();

        [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateWindowEx(int exStyle, string className, string windowName, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

        [DllImport("user32.dll")]
        public static extern bool DestroyWindow(IntPtr window);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string name);

        [DllImport("dwmapi.dll")]
        public static extern int DwmRegisterThumbnail(IntPtr destination, IntPtr source, out IntPtr thumbnail);

        [DllImport("dwmapi.dll")]
        public static extern int DwmUnregisterThumbnail(IntPtr thumbnail);

        [DllImport("dwmapi.dll")]
        public static extern int DwmUpdateThumbnailProperties(IntPtr thumbnail, ref ThumbnailProperties properties);

        [StructLayout(LayoutKind.Sequential)]
        public struct ThumbnailProperties
        {
            public int Flags;
            public Rect Destination;
            public Rect Source;
            public byte Opacity;
            public bool Visible;
            public bool SourceClientAreaOnly;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLength(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr window, out Rect rect);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr window, IntPtr deviceContext, uint flags);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

        [StructLayout(LayoutKind.Sequential)]
        public struct Rect
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;

            public int Width { get { return Math.Max(0, Right - Left); } }
            public int Height { get { return Math.Max(0, Bottom - Top); } }
        }
    }
}
