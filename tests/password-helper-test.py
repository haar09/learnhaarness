"""Run: python3 tests/password-helper-test.py (requires python3-bcrypt)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import bcrypt

spec = importlib.util.spec_from_file_location('password_helper', Path(__file__).parents[1] / 'deploy/password-helper.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PasswordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'users'
        self.original = b'learning ' + bcrypt.hashpw(b'original-password', bcrypt.gensalt(rounds=4)) + b'\n'
        self.path.write_bytes(self.original)
        self.commands = []
        self.changer = module.PasswordChanger(self.path, run=lambda command, **kwargs: self.commands.append(command), revision_file=Path(self.temp.name) / "revision")
        self.data = dict(currentPassword='original-password', newPassword='replacement-password', confirmPassword='replacement-password')

    def test_verify_only_preserves_credentials_and_revision(self):
        first = self.changer.control({'op': 'version'})
        result = self.changer.control({'op': 'verify', 'username': 'learning', 'password': 'original-password'})
        self.assertEqual(result['status'], 200)
        self.assertEqual(result['revision'], first['revision'])
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.commands, [])
        self.assertNotIn('$2', result['revision'])
        self.assertEqual(len(result['revision']), 64)

    def test_password_change_revokes_old_revision(self):
        before = self.changer.control({'op': 'version'})['revision']
        result = self.changer.control(self.data)
        self.assertEqual(result['status'], 200)
        self.assertNotEqual(result['revision'], before)
        self.assertEqual(self.changer.control({'op': 'verify', 'username': 'learning', 'password': 'original-password'})['status'], 403)
        self.assertEqual(self.changer.control({'op': 'verify', 'username': 'learning', 'password': 'replacement-password'})['status'], 200)

    def test_login_rate_limit_independent_of_password_change(self):
        for _ in range(5):
            self.assertEqual(self.changer.control({'op': 'verify', 'username': 'learning', 'password': 'wrong'})['status'], 403)
        self.assertEqual(self.changer.control({'op': 'verify', 'username': 'learning', 'password': 'original-password'})['status'], 429)
        self.assertEqual(self.changer.change(self.data), 200)

    def test_changes_and_verifies(self):
        self.assertEqual(self.changer.change(self.data), 200)
        self.assertTrue(bcrypt.checkpw(b'replacement-password', self.path.read_bytes().split()[1]))
        self.assertEqual(len(self.commands), 2)

    def test_wrong_current_is_rate_limited_and_unchanged(self):
        self.data['currentPassword'] = 'wrong'
        for _ in range(5):
            self.assertEqual(self.changer.change(self.data), 403)
        self.assertEqual(self.changer.change(self.data), 429)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.commands, [])

    def test_confirmation_and_length(self):
        for value in ('short', 'x' * 73):
            self.data.update(newPassword=value, confirmPassword=value)
            self.assertEqual(self.changer.change(self.data), 400)
        self.data.update(newPassword='replacement-password', confirmPassword='different-password')
        self.assertEqual(self.changer.change(self.data), 400)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_failed_reload_restores_original(self):
        def fail(command, **kwargs):
            raise RuntimeError('simulated failure')
        self.changer.run = fail
        self.assertEqual(self.changer.change(self.data), 503)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_other_users_and_duplicate_entry_fail_closed(self):
        self.path.write_bytes(self.original + self.original)
        self.assertEqual(self.changer.change(self.data), 503)
        self.assertEqual(self.path.read_bytes(), self.original * 2)

if __name__ == '__main__':
    unittest.main()
