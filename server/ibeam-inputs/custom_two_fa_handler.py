"""IB Key login for IBeam (IBEAM_TWO_FA_HANDLER=CUSTOM_HANDLER): one IBKR Mobile
notification, then a patient wait for your approval.

IBeam's own NOTIFICATION_RESEND handler waits only for "Client login succeeds".
After an approval IBKR's page can first show something else (such as the
IB Key promotion), so it timed out, logged in again and sent another
notification. This one waits for any of the pages that follow an approval;
IBeam then handles that page.
"""
import logging
import os
import time
from pathlib import Path

from selenium.webdriver.common.by import By

from ibeam.src.login.driver import save_screenshot
from ibeam.src.two_fa_handlers.two_fa_handler import TwoFaHandler

_LOGGER = logging.getLogger('ibeam.' + Path(__file__).stem)
WAIT_S = int(os.environ.get('IBEAM_APPROVAL_WAIT', 180))


def _shown(driver, target) -> bool:
    try:
        if target.type == 'TAG_NAME':   # a text anywhere on the page
            return any(target.identifier in el.text for el in driver.find_elements(By.TAG_NAME, 'body'))
        return any(el.is_displayed() for el in driver.find_elements(target.by, target.identifier))
    except Exception:  # noqa: BLE001 - the page is changing; look again
        return False


class CustomTwoFaHandler(TwoFaHandler):

    def get_two_fa_code(self, driver):
        raise NotImplementedError()

    def interact_with_notification(self, driver, targets) -> bool:
        _LOGGER.info(f'Waiting up to {WAIT_S} s for the login to be approved in IBKR Mobile.')
        after = [targets[k] for k in ('SUCCESS', 'IBKEY_PROMO', 'ERROR') if k in targets]
        end = time.time() + WAIT_S
        while time.time() < end:
            for target in after:
                if _shown(driver, target):
                    _LOGGER.info(f'Approval answered: {target}')
                    return True
            time.sleep(2)
        _LOGGER.error('The login was not approved in time.')
        save_screenshot(driver, self.outputs_dir, postfix='__approval-timeout')
        return False

    def __str__(self):
        return "CustomTwoFaHandler(IB Key, one notification)"
