const { spawnSync } = require("child_process");

const ps = String.raw`
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class KiaraWin32
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(
        IntPtr hWnd,
        System.Text.StringBuilder lpString,
        int nMaxCount
    );

    [DllImport("user32.dll")]
    public static extern int GetClassName(
        IntPtr hWnd,
        System.Text.StringBuilder lpClassName,
        int nMaxCount
    );

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(
        IntPtr hWnd,
        uint uCmd
    );

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(
        IntPtr hWnd,
        out uint processId
    );
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-Name {
    param(
        [System.Windows.Automation.AutomationElement]$Element
    )

    try {
        $c = $Element.Current

        if (-not [string]::IsNullOrWhiteSpace($c.Name)) {
            return $c.Name.Trim()
        }

        if (-not [string]::IsNullOrWhiteSpace($c.AutomationId)) {
            return $c.AutomationId.Trim()
        }

        return ""
    }
    catch {
        return ""
    }
}

function Get-Type {
    param(
        [System.Windows.Automation.AutomationElement]$Element
    )

    try {
        return ($Element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    }
    catch {
        return "Unknown"
    }
}

function Get-Role {
    param(
        [string]$Type
    )

    if ($Type -match 'Window') {
        return "window"
    }

    if ($Type -match 'Button') {
        return "button"
    }

    if ($Type -match 'Edit') {
        return "input"
    }

    if ($Type -match 'Document') {
        return "document"
    }

    if ($Type -match 'MenuItem') {
        return "menu_item"
    }

    if ($Type -match 'TabItem') {
        return "tab"
    }

    if ($Type -match 'TreeItem') {
        return "item"
    }

    if ($Type -match 'ListItem') {
        return "item"
    }

    if ($Type -match 'CheckBox') {
        return "checkbox"
    }

    if ($Type -match 'RadioButton') {
        return "radio"
    }

    if ($Type -match 'ComboBox') {
        return "dropdown"
    }

    if ($Type -match 'Slider') {
        return "slider"
    }

    if ($Type -match 'Hyperlink') {
        return "link"
    }

    if ($Type -match 'Text') {
        return "text"
    }

    if ($Type -match 'Pane') {
        return "section"
    }

    if ($Type -match 'Group') {
        return "section"
    }

    if ($Type -match 'List') {
        return "list"
    }

    if ($Type -match 'Tree') {
        return "tree"
    }

    return "container"
}

function Get-VisibleChildren {
    param(
        [System.Windows.Automation.AutomationElement]$Element
    )

    try {
        $items = @(
            $Element.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition
            )
        )

        $result = @()

        foreach ($item in $items) {
            try {
                if (-not $item.Current.IsOffscreen) {
                    $result += $item
                }
            }
            catch {
            }
        }

        return @($result)
    }
    catch {
        return @()
    }
}

function Get-SemanticNode {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [string]$Id,
        [string]$ParentId
    )

    try {
        $c = $Element.Current
        $name = Get-Name $Element
        $type = Get-Type $Element
        $role = Get-Role $type

        if ([string]::IsNullOrWhiteSpace($name)) {
            return $null
        }

        $children = @(Get-VisibleChildren $Element)

        $node = [ordered]@{
            id = $Id
            parentId = $ParentId
            name = $name
            role = $role
            enabled = [bool]$c.IsEnabled
            visible = -not [bool]$c.IsOffscreen
            hasChildren = ($children.Count -gt 0)
        }

        if ($type -match 'Button|MenuItem|Hyperlink') {
            $node.action = "click"
        }
        elseif ($type -match 'Edit') {
            $node.actions = @(
                "focus",
                "type",
                "clear"
            )
        }
        elseif ($type -match 'TabItem') {
            $node.action = "select"
        }
        elseif ($type -match 'CheckBox') {
            $node.action = "toggle"
        }
        elseif ($type -match 'ComboBox') {
            $node.actions = @(
                "open",
                "select"
            )
        }
        elseif ($type -match 'Slider') {
            $node.action = "set_value"
        }

        return $node
    }
    catch {
        return $null
    }
}

function Get-MeaningfulChildren {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [string]$ParentId,
        [int]$Limit = 40
    )

    $children = @(Get-VisibleChildren $Element)

    $result = @()
    $counter = 0
    $seen = @{}

    foreach ($child in $children) {
        if ($result.Count -ge $Limit) {
            break
        }

        try {
            $name = Get-Name $child
            $type = Get-Type $child

            if ([string]::IsNullOrWhiteSpace($name)) {
                continue
            }

            $key = $name.ToLowerInvariant() + "|" + $type

            if ($seen.ContainsKey($key)) {
                continue
            }

            $seen[$key] = $true
            $counter++

            $node = Get-SemanticNode -Element $child -Id ($ParentId + "_" + $counter) -ParentId $ParentId

            if ($null -eq $node) {
                continue
            }

            $useful = $false

            if ($node.role -in @(
                "button",
                "input",
                "document",
                "menu_item",
                "tab",
                "checkbox",
                "radio",
                "dropdown",
                "slider",
                "link",
                "text",
                "section",
                "list",
                "tree",
                "item"
            )) {
                $useful = $true
            }

            if ($node.hasChildren) {
                $useful = $true
            }

            if ($useful) {
                $result += $node
            }
        }
        catch {
        }
    }

    return @($result)
}

function Get-WindowTitle {
    param(
        [IntPtr]$Handle
    )

    $builder = New-Object System.Text.StringBuilder 1024

    [KiaraWin32]::GetWindowText(
        $Handle,
        $builder,
        $builder.Capacity
    ) | Out-Null

    return $builder.ToString().Trim()
}

function Get-WindowClass {
    param(
        [IntPtr]$Handle
    )

    $builder = New-Object System.Text.StringBuilder 256

    [KiaraWin32]::GetClassName(
        $Handle,
        $builder,
        $builder.Capacity
    ) | Out-Null

    return $builder.ToString().Trim()
}

function Get-TopLevelWindows {
    $result = @()

    $desktop = [System.Windows.Automation.AutomationElement]::RootElement

    try {
        $windows = @(
            $desktop.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition
            )
        )

        foreach ($window in $windows) {
            try {
                $c = $window.Current

                if ($c.ControlType -ne [System.Windows.Automation.ControlType]::Window) {
                    continue
                }

                if ($c.IsOffscreen) {
                    continue
                }

                if ([string]::IsNullOrWhiteSpace($c.Name)) {
                    continue
                }

                $result += $window
            }
            catch {
            }
        }
    }
    catch {
    }

    return @($result)
}

$foreground = [KiaraWin32]::GetForegroundWindow()

if ($foreground -eq [IntPtr]::Zero) {
    @{
        success = $false
        error = "ACTIVE_WINDOW_NOT_FOUND"
    } | ConvertTo-Json -Depth 20 -Compress

    exit
}

$processId = [uint32]0

[KiaraWin32]::GetWindowThreadProcessId(
    $foreground,
    [ref]$processId
) | Out-Null

$activeWindow = [System.Windows.Automation.AutomationElement]::FromHandle($foreground)

if ($null -eq $activeWindow) {
    @{
        success = $false
        error = "UIA_ACTIVE_WINDOW_NOT_FOUND"
    } | ConvertTo-Json -Depth 20 -Compress

    exit
}

$activeName = Get-Name $activeWindow
$activeType = Get-Type $activeWindow
$activeClass = Get-WindowClass $foreground

$topWindows = @(Get-TopLevelWindows)

$applications = @()
$appIndex = 0

foreach ($window in $topWindows) {
    try {
        $windowName = Get-Name $window

        if ([string]::IsNullOrWhiteSpace($windowName)) {
            continue
        }

        $windowHandle = $window.Current.NativeWindowHandle

        if ($windowHandle -eq 0) {
            continue
        }

        $windowProcessId = [uint32]0

        [KiaraWin32]::GetWindowThreadProcessId(
            [IntPtr]$windowHandle,
            [ref]$windowProcessId
        ) | Out-Null

        $windowClass = Get-WindowClass ([IntPtr]$windowHandle)

        $appIndex++

        $app = [ordered]@{
            id = "app_" + $appIndex
            name = $windowName
            processId = $windowProcessId
            active = ($windowHandle -eq $foreground.ToInt64())
            className = $windowClass
        }

        $applications += $app
    }
    catch {
    }
}

$activeChildren = @(Get-MeaningfulChildren $activeWindow "active" 50)

$taskbar = $null

try {
    $taskbarCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        "Shell_TrayWnd"
    )

    $taskbar = $desktop.FindFirst(
        [System.Windows.Automation.TreeScope]::Children,
        $taskbarCondition
    )
}
catch {
}

$taskbarItems = @()

if ($null -ne $taskbar) {
    $taskbarItems = @(Get-MeaningfulChildren $taskbar "taskbar" 40)
}

$screenSummary = [ordered]@{
    activeApplication = $activeName
    openApplications = @($applications | ForEach-Object {
        $_.name
    })
}

$result = [ordered]@{
    success = $true

    screen = $screenSummary

    applications = @($applications)

    activeApplication = [ordered]@{
        name = $activeName
        processId = $processId
        windowHandle = $foreground.ToInt64()
        className = $activeClass
        role = "application"
        visibleItems = @($activeChildren)
    }

    taskbar = [ordered]@{
        visible = ($null -ne $taskbar)
        availableItems = @($taskbarItems)
    }

    observation = [ordered]@{
        mode = "human_level"
        hierarchy = "application_then_visible_items"
        detailedChildren = "on_demand"
    }
}

$result | ConvertTo-Json -Depth 30 -Compress
`;

const result = spawnSync(
    "powershell.exe",
    [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        ps
    ],
    {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 20 * 1024 * 1024
    }
);

if (result.error) {
    console.error(
        JSON.stringify(
            {
                success: false,
                error: "UIA_OBSERVATION_FAILED",
                message: result.error.message
            },
            null,
            2
        )
    );
    process.exit(1);
}

if (result.status !== 0) {
    console.error(
        JSON.stringify(
            {
                success: false,
                error: "UIA_OBSERVATION_FAILED",
                message: (result.stderr || "").trim()
            },
            null,
            2
        )
    );
    process.exit(1);
}

const output = (result.stdout || "").trim();

if (!output) {
    console.error(
        JSON.stringify(
            {
                success: false,
                error: "EMPTY_UIA_OBSERVATION"
            },
            null,
            2
        )
    );
    process.exit(1);
}

try {
    const parsed = JSON.parse(output);

    process.stdout.write(
        JSON.stringify(parsed, null, 2) + "\n"
    );
}
catch (error) {
    console.error(
        JSON.stringify(
            {
                success: false,
                error: "INVALID_UIA_OUTPUT",
                message: error.message,
                raw: output
            },
            null,
            2
        )
    );
    process.exit(1);
}