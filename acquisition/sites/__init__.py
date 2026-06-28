from . import standard_ebooks

SITES = [standard_ebooks]


def find_site(url):
    for site in SITES:
        if site.match(url):
            return site
    return None
