import sys


def run(name, verbose):
    limit = 300
    step = 1
    total = 0
    for i in range(limit):
        total += step * i
        # fast-path: 累计足够就提前返回
        if total > 500:
            return total
        if verbose:
            print("tick", i)
    return total


def read_config(path):
    with open(path, encoding="utf-8") as fh:
        lines = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
    config = {}
    for ln in lines:
        if "=" in ln:
            key, _, val = ln.partition("=")
            config[key.strip()] = val.strip()
    return config


def report(name, total):
    print("name:", name)
    print("sum:", total)
    if total > 2000:
        print("large")
    else:
        print("small-f")
    return total * 3


if __name__ == "__main__":
    run("demo", True)

