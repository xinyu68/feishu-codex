# Native window operations shared by the verified Codex entry point and isolated
# desktop tests. Never launch or terminate a process to recover a hidden window.
if (-not ('FeishuCodex.NativeWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace FeishuCodex {
    public static class NativeWindow {
        private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr window);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

        private static bool BelongsTo(IntPtr window, uint processId) {
            uint owner;
            return window != IntPtr.Zero && processId > 0 && GetWindowThreadProcessId(window, out owner) != 0 && owner == processId;
        }

        public static IntPtr FindMainWindow(uint processId) {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                if (!BelongsTo(window, processId)) return true;
                var className = new StringBuilder(256);
                GetClassName(window, className, className.Capacity);
                // Exclude Electron's tray, untitled helper and avatar/tool windows.
                if (className.ToString() != "Chrome_WidgetWin_1" || GetWindowTextLength(window) == 0 ||
                    (GetWindowLong(window, -20) & 0x08000080) != 0 ||
                    (GetWindowLong(window, -16) & 0xC00000) != 0xC00000 ||
                    GetWindow(window, 4) != IntPtr.Zero) return true;
                if (found == IntPtr.Zero || IsWindowVisible(window)) found = window;
                return !IsWindowVisible(window);
            }, IntPtr.Zero);
            return found;
        }

        public static bool Restore(IntPtr window, uint processId) {
            if (!BelongsTo(window, processId)) return false;
            // SW_RESTORE for minimized windows; SW_SHOW preserves maximization.
            if (IsIconic(window)) ShowWindowAsync(window, 9);
            else if (!IsWindowVisible(window)) ShowWindowAsync(window, 5);
            return IsWindowVisible(window) && !IsIconic(window);
        }

        public static bool Activate(IntPtr window, uint processId) {
            if (!BelongsTo(window, processId) || !IsWindowVisible(window) || IsIconic(window)) return false;
            return GetForegroundWindow() == window || SetForegroundWindow(window);
        }
    }
}
'@
}
