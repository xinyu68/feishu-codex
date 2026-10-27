param([Parameter(Mandatory=$true)][string]$InputFile, [Parameter(Mandatory=$true)][string]$ResultFile, [Parameter(Mandatory=$true)][string]$OperationId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace FeishuForceExit {
  public class Owner { public int pid; public string exe; public string startedAt; }
  public class Result { public int requested; public int terminated; public int skipped; public List<string> warnings = new List<string>(); }
  public static class Native {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Entry { public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle,uint flags,StringBuilder name,ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    sealed class Held { public int pid; public IntPtr handle; public long created; public string exe; }
    static Held Read(int pid) {
      IntPtr h=OpenProcess(0x1000|0x100000|1,false,pid);
      if(h==IntPtr.Zero)return null;
      long c,e,k,u;uint size=32768;var name=new StringBuilder((int)size);
      if(!GetProcessTimes(h,out c,out e,out k,out u)||!QueryFullProcessImageNameW(h,0,name,ref size)){CloseHandle(h);return null;}
      return new Held{pid=pid,handle=h,created=c,exe=name.ToString()};
    }
    static bool EqualPath(string a,string b){return String.Equals(a,b,StringComparison.OrdinalIgnoreCase);}
    public static Result Stop(Owner[] owners,string[] protectedExecutables,int caller,int helper,bool descendants) {
      var result=new Result();var rows=new Dictionary<int,Entry>();var children=new Dictionary<int,List<int>>();var held=new Dictionary<int,Held>();var order=new List<Held>();
      long snapshotTime=DateTime.UtcNow.ToFileTimeUtc();
      IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
      if(snapshot==new IntPtr(-1))throw new InvalidOperationException("Cannot enumerate processes");
      try {
        var row=new Entry();row.size=(uint)Marshal.SizeOf(typeof(Entry));
        if(Process32FirstW(snapshot,ref row))do{rows[(int)row.pid]=row;List<int> list;if(!children.TryGetValue((int)row.parent,out list)){list=new List<int>();children[(int)row.parent]=list;}list.Add((int)row.pid);}while(Process32NextW(snapshot,ref row));
      } finally {CloseHandle(snapshot);}
      try {
        foreach(var owner in owners) {
          if(owner.pid==caller||owner.pid==helper||held.ContainsKey(owner.pid))continue;
          var root=Read(owner.pid);
          if(root==null){if(rows.ContainsKey(owner.pid))result.warnings.Add("Cannot open owned process "+owner.pid);else result.skipped++;continue;}
          long expected=DateTimeOffset.Parse(owner.startedAt).UtcDateTime.ToFileTimeUtc();
          if(!EqualPath(root.exe,owner.exe)||root.created/10!=expected/10){CloseHandle(root.handle);result.skipped++;continue;}
          bool rootProtected=false;foreach(var exe in protectedExecutables)if(EqualPath(root.exe,exe))rootProtected=true;
          if(rootProtected){CloseHandle(root.handle);result.skipped++;continue;}
          held[root.pid]=root;order.Add(root);
          var queue=new Queue<Held>();if(descendants)queue.Enqueue(root);
          while(queue.Count>0){var parent=queue.Dequeue();List<int> list;if(!children.TryGetValue(parent.pid,out list))continue;
            foreach(int pid in list){if(pid==caller||pid==helper||held.ContainsKey(pid))continue;var child=Read(pid);if(child==null)continue;
              bool protect=child.created<parent.created||child.created>snapshotTime;foreach(var exe in protectedExecutables)if(EqualPath(child.exe,exe))protect=true;
              if(protect){CloseHandle(child.handle);continue;}held[pid]=child;order.Add(child);queue.Enqueue(child);
            }
          }
        }
        // Retain handles before issuing kills: a reused PID cannot redirect a kill.
        // Host is the first recorded root so it cannot restart stopped workers.
        foreach(var item in order){if(WaitForSingleObject(item.handle,0)==0)continue;result.requested++;
          if(TerminateProcess(item.handle,1))result.terminated++;else if(WaitForSingleObject(item.handle,0)!=0)result.warnings.Add("Cannot terminate owned process "+item.pid+" ("+Marshal.GetLastWin32Error()+")");
        }
        // Do not wait for process handles, sockets or Windows bookkeeping to drain.
        return result;
      } finally {foreach(var item in held.Values)CloseHandle(item.handle);}
    }
  }
}
'@
$inputData = [IO.File]::ReadAllText($InputFile) | ConvertFrom-Json
$owners = @($inputData.roots | ForEach-Object { $owner = New-Object FeishuForceExit.Owner; $owner.pid = $_.pid; $owner.exe = $_.exe; $owner.startedAt = $_.startedAt; $owner })
$summary = [FeishuForceExit.Native]::Stop([FeishuForceExit.Owner[]]$owners, [string[]]$inputData.preserveExecutables, [int]$inputData.callerPid, $PID, -not [bool]$inputData.rootOnly)
$receipt = @{ schema = 1; operationId = $OperationId; success = $true; requested = $summary.requested; terminated = $summary.terminated; skipped = $summary.skipped; warnings = @($summary.warnings) } | ConvertTo-Json -Depth 5 -Compress
[IO.File]::WriteAllText($ResultFile, $receipt, [Text.UTF8Encoding]::new($false))
exit 0
