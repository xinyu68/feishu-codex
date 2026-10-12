# Read TCP ownership directly instead of querying the slow NetTCPIP CIM provider.
# Both address families are required: incomplete ownership data must fail closed.
if (-not ('FeishuCodex.TcpSnapshot' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
namespace FeishuCodex {
    public sealed class TcpConnection {
        public int pid;
        public string state;
        public string localAddress;
        public int localPort;
        public string remoteAddress;
        public int remotePort;
    }
    public static class TcpSnapshot {
        [DllImport("iphlpapi.dll", SetLastError = true)]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
        private static int Port(IntPtr row, int offset) {
            return (Marshal.ReadByte(row, offset) << 8) | Marshal.ReadByte(row, offset + 1);
        }
        private static string Address(IntPtr row, int offset, int length, long scope) {
            byte[] bytes = new byte[length];
            Marshal.Copy(IntPtr.Add(row, offset), bytes, 0, length);
            return (length == 16 ? new IPAddress(bytes, scope) : new IPAddress(bytes)).ToString();
        }
        public static TcpConnection[] Read(int[] ports) {
            var wanted = new HashSet<int>(ports);
            var found = new List<TcpConnection>();
            foreach (int family in new int[] { 2, 23 }) {
                int size = 0;
                uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 5, 0);
                if (result != 122 && result != 0) throw new Win32Exception((int)result);
                bool complete = false;
                for (int attempt = 0; attempt < 5; attempt++) {
                    int allocated = Math.Max(size, 4);
                    IntPtr table = Marshal.AllocHGlobal(allocated);
                    try {
                        result = GetExtendedTcpTable(table, ref size, false, family, 5, 0);
                        if (result == 122) continue; // Connections changed while allocating.
                        if (result != 0) throw new Win32Exception((int)result);
                        int count = Marshal.ReadInt32(table);
                        int stride = family == 2 ? 24 : 56;
                        if (count < 0 || count > (allocated - 4) / stride) throw new InvalidOperationException("Invalid TCP ownership table");
                        for (int i = 0; i < count; i++) {
                            IntPtr row = IntPtr.Add(table, 4 + i * stride);
                            int local = Port(row, family == 2 ? 8 : 20);
                            int remote = Port(row, family == 2 ? 16 : 44);
                            if (!wanted.Contains(local) && !wanted.Contains(remote)) continue;
                            found.Add(new TcpConnection {
                                pid = Marshal.ReadInt32(row, family == 2 ? 20 : 52),
                                state = ((TcpState)Marshal.ReadInt32(row, family == 2 ? 0 : 48)).ToString(),
                                localAddress = Address(row, family == 2 ? 4 : 0, family == 2 ? 4 : 16, family == 2 ? 0 : (uint)Marshal.ReadInt32(row, 16)),
                                localPort = local,
                                remoteAddress = Address(row, family == 2 ? 12 : 24, family == 2 ? 4 : 16, family == 2 ? 0 : (uint)Marshal.ReadInt32(row, 40)),
                                remotePort = remote
                            });
                        }
                        complete = true;
                        break;
                    } finally { Marshal.FreeHGlobal(table); }
                }
                if (!complete) throw new InvalidOperationException("TCP ownership table kept changing; retry inspection");
            }
            return found.ToArray();
        }
    }
}
'@
}
