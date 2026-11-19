$ErrorActionPreference = 'Stop'
$root = $env:DEVHUB_PROFILE_CHECK_ROOT
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$securityIdentifier = [System.Security.Principal.SecurityIdentifier]
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
function Test-PrivatePath([string]$path, [bool]$directory) {
    $attributes = [IO.File]::GetAttributes($path)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [bool]($attributes -band [IO.FileAttributes]::Directory) -ne $directory) {
        throw 'The Codex profile uses an unsafe path type.'
    }
    $acl = if ($directory) { [IO.Directory]::GetAccessControl($path, $sections) } else { [IO.File]::GetAccessControl($path, $sections) }
    if ($acl.GetOwner($securityIdentifier).Value -notin $trusted) { throw 'The owner is not trusted.' }
    $rules = @($acl.GetAccessRules($true, $true, $securityIdentifier))
    if ($rules.Count -eq 0) { throw 'The profile has no explicit access rules.' }
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
            $rule.IdentityReference.Value -notin $trusted) {
            throw 'The profile grants access to an additional principal.'
        }
    }
}
Test-PrivatePath $root $true
$auth = [IO.Path]::Combine($root, 'auth.json')
if ([IO.File]::Exists($auth)) { Test-PrivatePath $auth $false }
