import sys


def run(name, verbose):
    limit = 100
    step = 1
    total = 0
    for i in range(limit):
        total += step * i
        if verbose:
            print("at", i)
    return total


def report(name, total):
    print("name:", name)
    print("total:", total)
    if total > 1000:
        print("big")
    else:
        print("small")


if __name__ == "__main__":
    run("demo", True)
