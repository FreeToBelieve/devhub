$ErrorActionPreference = 'Stop'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($current, 'S-1-5-18', 'S-1-5-32-544')
$access = [System.Security.AccessControl.AccessControlSections]::Access
$sections = $access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$directory = [IO.FileAttributes]::Directory
$reparse = [IO.FileAttributes]::ReparsePoint
$inherit = [System.Security.AccessControl.AceFlags]::ObjectInherit -bor [System.Security.AccessControl.AceFlags]::ContainerInherit
$notEffective = [System.Security.AccessControl.AceFlags]::InheritOnly -bor [System.Security.AccessControl.AceFlags]::NoPropagateInherit
$fullControl = [int][System.Security.AccessControl.FileSystemRights]::FullControl

function Get-DirectoryAcl([string] $Path) {
    $attributes = [IO.File]::GetAttributes($Path)
    if (-not ($attributes -band $directory) -or ($attributes -band $reparse)) { throw 'Unsafe directory' }
    $acl = [IO.Directory]::GetAccessControl($Path, $sections)
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Unsafe owner' }
    return $acl
}

function Assert-PrivateDirectory([string] $Path, [bool] $Child) {
    $acl = Get-DirectoryAcl $Path
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl -or -not $acl.AreAccessRulesCanonical -or
        ($Child -and $acl.AreAccessRulesProtected)) { throw 'Unsafe DACL' }
    $currentInherits = $false
    foreach ($rule in $raw.DiscretionaryAcl) {
        if ($rule -isnot [System.Security.AccessControl.CommonAce] -or $rule.IsCallback) { throw 'Unexpected ACE' }
        if ($rule.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
        if ($rule.SecurityIdentifier.Value -notin $trusted) { throw 'Unexpected Allow ACE' }
        if ($rule.SecurityIdentifier.Value -eq $current -and ($rule.AccessMask -band $fullControl) -eq $fullControl -and
            ($rule.AceFlags -band $inherit) -eq $inherit -and -not ($rule.AceFlags -band $notEffective) -and
            (-not $Child -or $rule.IsInherited)) { $currentInherits = $true }
    }
    if (-not $currentInherits) { throw 'Missing inheritable current-user access' }
}

$root = $env:DEVHUB_UNITY_ACL_ROOT
if ($env:DEVHUB_UNITY_ACL_MANAGED -eq '1') {
    $acl = Get-DirectoryAcl $root
    $acl.SetSecurityDescriptorSddlForm(('D:P(A;OICI;FA;;;{0})' -f $current), $access)
    [IO.Directory]::SetAccessControl($root, $acl)
}
Assert-PrivateDirectory $root $false
if ($env:DEVHUB_UNITY_ACL_CHILD) { Assert-PrivateDirectory $env:DEVHUB_UNITY_ACL_CHILD $true }
