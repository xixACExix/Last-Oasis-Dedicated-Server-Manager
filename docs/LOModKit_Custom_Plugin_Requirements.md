# LO ModKit Custom Plugin Requirements

This note captures what would be required if we want to ship a prebuilt custom plugin for the Last Oasis ModKit later.

## What is confirmed

1. The ModKit project supports project plugins.
2. The project already loads many plugins from `Game/Plugins`.
3. This ModKit is based on Unreal Engine `4.25.4`.
4. Shipped plugins are mostly prebuilt with:
   - `Binaries/Win64/UE4Editor-<Plugin>.dll`
   - `Binaries/Win64/UE4Editor.modules`
   - optional debug DLL/PDB variants

## What is broken in this local install

The packaged ModKit does not include `Engine/Source`.

That breaks local code-plugin compilation because:

- `Engine/Build/BatchFiles/Build.bat` changes into `..\\..\\Source`
- `UnrealBuildTool.exe` also fails immediately when `Engine\\Source` is missing

So this install is not a healthy place to compile a new C++ plugin directly.

## External build environment we would need

To build a compatible prebuilt plugin elsewhere, we would need all of this:

1. A full Unreal Engine `4.25.4` source/binary environment that matches the ModKit runtime closely enough.
2. Visual Studio C++ toolchain for the matching UE4 build.
3. The plugin source folder with:
   - `.uplugin`
   - `Source/<ModuleName>/`
   - `.Build.cs`
   - public/private headers and cpp files
4. A target build that produces Win64 editor binaries matching this pattern:
   - `UE4Editor-<Plugin>.dll`
   - `UE4Editor.modules`

## Compatibility risk

Even if we build against UE `4.25.4`, there is still risk unless the external build matches the exact headers/binary expectations used by the Last Oasis ModKit package.

That means the safest plugin path is:

1. build externally
2. drop the finished plugin into `Game/Plugins/<PluginName>`
3. test startup in the ModKit before doing any gameplay work

## Recommendation

For the announcement system, prefer the content-mod route in `Content/Mods/DOstuff` first.

Only return to the prebuilt custom-plugin path if:

- the Blueprint/content path hits a hard wall, and
- we are ready to stand up a matching external UE `4.25.4` plugin build environment
