$ErrorActionPreference = 'Stop'
$filename = $env:DEVHUB_SQLITE_FILE
$directory = [IO.Path]::GetDirectoryName($filename)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$access = [System.Security.AccessControl.AccessControlSections]::Access
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$reparsePoint = [IO.FileAttributes]::ReparsePoint

function Set-PrivateAcl([string] $ItemPath, [bool] $IsDirectory) {
    $attributes = [IO.File]::GetAttributes($ItemPath)
    $isActualDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
    if ($isActualDirectory -ne $IsDirectory -or ($attributes -band $reparsePoint)) {
        throw 'A SQLite path is not an ordinary file or directory.'
    }
    $fileSystem = if ($IsDirectory) { [IO.Directory] } else { [IO.File] }
    $inheritance = if ($IsDirectory) { 'OICI' } else { '' }
    $acl = $fileSystem::GetAccessControl($ItemPath, $access)
    $acl.SetSecurityDescriptorSddlForm(('D:P(A;{0};FA;;;{1})' -f $inheritance, $sid.Value), $access)
    $fileSystem::SetAccessControl($ItemPath, $acl)

    $applied = $fileSystem::GetAccessControl($ItemPath, $access)
    $rules = @($applied.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (-not $applied.AreAccessRulesProtected -or $rules.Count -ne 1 -or
        $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne $allow -or
        $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        throw 'The filesystem did not retain the private Windows ACL.'
    }
}

if ($env:DEVHUB_SQLITE_MANAGED_DIR -eq '1') {
    Set-PrivateAcl $directory $true
} else {
    # SQLite creates rollback journals alongside the database. New files inherit the parent ACL.
    $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $parentAcl = [IO.Directory]::GetAccessControl($directory, $access)
    $rules = $parentAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq $allow -and $rule.IdentityReference.Value -notin $trusted) {
            throw 'The external database directory grants access to other Windows principals.'
        }
    }
}

if (-not [IO.File]::Exists($filename)) {
    try {
        $stream = [IO.File]::Open($filename, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        $stream.Dispose()
    } catch [IO.IOException] {
        if (-not [IO.File]::Exists($filename)) { throw }
    }
}
Set-PrivateAcl $filename $false
foreach ($suffix in @('-journal', '-wal', '-shm')) {
    $sidecar = $filename + $suffix
    if ([IO.File]::Exists($sidecar)) { Set-PrivateAcl $sidecar $false }
}
