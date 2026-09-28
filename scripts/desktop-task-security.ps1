function Test-DesktopTaskUserAccess {
    param([Parameter(Mandatory=$true)][string]$Sddl, [Parameter(Mandatory=$true)][string]$UserSid)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $sid = [Security.Principal.SecurityIdentifier]::new($UserSid)
    if ($null -eq $descriptor.DiscretionaryAcl) { return $false }
    $fullAccess = 0x1F01FF
    foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace -is [Security.AccessControl.CommonAce] -and $ace.SecurityIdentifier -eq $sid -and -not $ace.IsInherited -and $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and ($ace.AccessMask -band $fullAccess) -eq $fullAccess) { return $true }
    }
    return $false
}

function Get-DesktopTaskUserSddl {
    param([Parameter(Mandatory=$true)][string]$Sddl, [Parameter(Mandatory=$true)][string]$UserSid)
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $sid = [Security.Principal.SecurityIdentifier]::new($UserSid)
    $fullAccess = 0x1F01FF
    if ($null -eq $descriptor.DiscretionaryAcl) { throw '计划任务没有可验证的访问权限列表，未更改权限。' }
    foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace -is [Security.AccessControl.CommonAce] -and $ace.SecurityIdentifier -eq $sid -and $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied -and ($ace.AccessMask -band $fullAccess)) { throw '计划任务明确拒绝当前用户的访问，未覆盖现有拒绝规则。' }
    }
    if (Test-DesktopTaskUserAccess $Sddl $UserSid) { return $Sddl }
    # Preserve the owner, group and every existing ACE (especially BA and SY).
    # Explicit allows precede inherited entries in a canonical DACL.
    $index = $descriptor.DiscretionaryAcl.Count
    for ($i = 0; $i -lt $descriptor.DiscretionaryAcl.Count; $i++) {
        if ($descriptor.DiscretionaryAcl[$i].IsInherited) { $index = $i; break }
    }
    $allow = [Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, $fullAccess, $sid, $false, $null)
    $descriptor.DiscretionaryAcl.InsertAce($index, $allow)
    return $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}

function Grant-DesktopTaskUserAccess {
    param([Parameter(Mandatory=$true)][string]$TaskName, [Parameter(Mandatory=$true)][string]$UserSid)
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $task = $scheduler.GetFolder('\').GetTask($TaskName)
    # Owner/group/DACL only. Reading the SACL would require extra privileges.
    $original = $task.GetSecurityDescriptor(7)
    $updated = Get-DesktopTaskUserSddl $original $UserSid
    if ($updated -ne $original) { $task.SetSecurityDescriptor($updated, 0) }
    if (-not (Test-DesktopTaskUserAccess ($task.GetSecurityDescriptor(7)) $UserSid)) { throw '计划任务已创建，但未能确认当前用户的管理权限。请保留回退日志。' }
}
