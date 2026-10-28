"""One-off: shows how IBKR's "Select Second Factor Device" list is built, so
IBeam can be told how to pick IB Key. Runs inside the ibeam container with
its browser and the IBEAM_ACCOUNT / IBEAM_PASSWORD already set there.
It submits your paper login once and stops at the list (it never picks a
device or logs in). It prints only page markup, never your password.

  docker cp probe_2fa_list.py ibeam:/tmp/
  docker exec ibeam python /tmp/probe_2fa_list.py
"""
import os
import re
import time

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By

URL = "https://www.interactivebrokers.com/sso/Login?forwardTo=22&RL=1&ip2loc=on"

opts = webdriver.ChromeOptions()
for a in ("--headless", "--disable-gpu", "--no-sandbox", "--incognito", "--disable-dev-shm-usage"):
    opts.add_argument(a)
d = webdriver.Chrome(service=Service("/usr/bin/chromedriver"), options=opts)
d.set_window_size(1280, 1000)


def clean(html, n=3000):
    html = re.sub(r"\s+", " ", html)
    return html.replace(os.environ.get("IBEAM_PASSWORD", "\0"), "***")[:n]


try:
    d.get(URL)
    time.sleep(6)
    user = (d.find_elements(By.NAME, "username") or d.find_elements(By.NAME, "user_name"))[0]
    pwd = d.find_elements(By.NAME, "password")[0]
    if os.environ.get("IBEAM_USE_PAPER_ACCOUNT", "").lower() in ("1", "true", "yes"):
        toggles = d.find_elements(By.CSS_SELECTOR, "label[for=toggle1]")
        if toggles:
            toggles[0].click()
            time.sleep(2)
    user.send_keys(os.environ["IBEAM_ACCOUNT"])
    pwd.send_keys(os.environ["IBEAM_PASSWORD"])
    time.sleep(2)
    buttons = d.find_elements(By.CSS_SELECTOR, ".btn.btn-lg.xyz-button-login") or d.find_elements(By.CSS_SELECTOR, "button[type=submit]")
    [b for b in buttons if b.is_displayed()][0].click()
    time.sleep(12)
    print("== selects:")
    for s in d.find_elements(By.TAG_NAME, "select"):
        print("visible" if s.is_displayed() else "hidden", clean(s.get_attribute("outerHTML"), 800))
    print("== around 'Second Factor':")
    for e in d.find_elements(By.XPATH, "//*[contains(text(), 'Second Factor')]"):
        box = e.find_element(By.XPATH, "./ancestor::*[3]")
        print(clean(box.get_attribute("outerHTML")))
    print("== around 'Select Type':")
    for e in d.find_elements(By.XPATH, "//*[contains(text(), 'Select Type')]")[:3]:
        print(clean(e.find_element(By.XPATH, "./ancestor::*[2]").get_attribute("outerHTML"), 1500))
finally:
    d.quit()
