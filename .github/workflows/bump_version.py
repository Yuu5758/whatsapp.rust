import json

def main():
    # 1. Update tauri.conf.json
    with open('src-tauri/tauri.conf.json', 'r') as f:
        data = json.load(f)
    v = data['version']
    parts = v.split('.')
    parts[-1] = str(int(parts[-1]) + 1)
    new_v = '.'.join(parts)
    data['version'] = new_v
    with open('src-tauri/tauri.conf.json', 'w') as f:
        json.dump(data, f, indent=2)

    # 2. Update Cargo.toml
    with open('src-tauri/Cargo.toml', 'r') as f:
        lines = f.readlines()
    for i, line in enumerate(lines):
        if line.strip().startswith('version ='):
            indent = line[:line.find('version =')]
            lines[i] = f'{indent}version = "{new_v}"\n'
            break
    with open('src-tauri/Cargo.toml', 'w') as f:
        f.writelines(lines)

    # 3. Update Cargo.lock
    with open('src-tauri/Cargo.lock', 'r') as f:
        lines = f.readlines()
    in_whatrust = False
    for i, line in enumerate(lines):
        if line.strip() == 'name = "whatrust"':
            in_whatrust = True
        elif in_whatrust and line.strip().startswith('version ='):
            indent = line[:line.find('version =')]
            lines[i] = f'{indent}version = "{new_v}"\n'
            break
    with open('src-tauri/Cargo.lock', 'w') as f:
        f.writelines(lines)

    # 4. Save the new version to a file so bash can read it
    with open('new_version.txt', 'w') as f:
        f.write(new_v)

if __name__ == '__main__':
    main()
