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
        self.changer = module.PasswordChanger(self.path, run=lambda command, **kwargs: self.commands.append(command))
        self.data = dict(currentPassword='original-password', newPassword='replacement-password', confirmPassword='replacement-password')

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
