import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load('backup')
preflight = load('preflight')


def archive(extra=None, manifest=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        for folder in ['media/backend', 'media/uploads']:
            member = tarfile.TarInfo(folder)
            member.type = tarfile.DIRTYPE
            tar.addfile(member)
        for name, data in [('database.dump', b'PGDMP'), ('manifest.json', json.dumps(manifest or {'project':'tijoratmarkazi','database':'tijorat_markazi_db','version':1}).encode())]:
            member = tarfile.TarInfo(name)
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
        if extra:
            tar.addfile(extra)
    output.seek(0)
    return tarfile.open(fileobj=output, mode='r:gz')


class StorageTests(unittest.TestCase):
    def test_preflight_rejects_wrong_project_before_any_docker_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'runtime').mkdir()
            (root/'runtime/compose.env').write_text('DB_NETWORK=database\n')
            (root/'runtime/backend.env').write_text('DB_NAME=agrozanjir_db\nDB_USER=agrozanjir_user\n')
            with patch.object(preflight,'inspect') as docker:
                with self.assertRaisesRegex(ValueError,'outside the confirmed project'):
                    preflight.check(root)
                docker.assert_not_called()
    def test_project_archive_and_wrong_project(self):
        with archive() as tar:
            backup.validate_archive(tar)
        with archive(manifest={'project':'agrozanjir'}) as tar:
            with self.assertRaises(ValueError):
                backup.validate_archive(tar)

    def test_reject_traversal_links_and_unrelated_files(self):
        for name in ['../outside', '/etc/passwd', 'media/uploads/../../outside', 'runtime/backend.env', r'media/uploads/..\outside']:
            with archive(tarfile.TarInfo(name)) as tar:
                with self.assertRaises(ValueError):
                    backup.validate_archive(tar)
        link = tarfile.TarInfo('media/uploads/link')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'
        with archive(link) as tar:
            with self.assertRaises(ValueError):
                backup.validate_archive(tar)

    def test_database_and_role_are_project_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'runtime').mkdir()
            (root/'runtime/compose.env').write_text('DB_CONTAINER=fixture-postgres\n')
            (root/'runtime/backend.env').write_text('DB_NAME=agrozanjir_db\nDB_USER=agrozanjir_user\nPOSTGRES_PASSWORD=fixture\n')
            with self.assertRaisesRegex(ValueError, 'outside this project'):
                backup.config(root)

    def test_restore_requires_stopped_backend_and_confirmation(self):
        env = {'DB_NAME':'tijorat_markazi_db'}
        with patch.object(backup, 'config', return_value=env), patch.object(backup.subprocess,'check_output',return_value='running-id'):
            with self.assertRaisesRegex(ValueError,'confirmation'):
                backup.restore(Path('/fixture'), '/unused', '--confirm=other_db')
            with self.assertRaisesRegex(ValueError,'Stop this project'):
                backup.restore(Path('/fixture'), '/unused', '--confirm=tijorat_markazi_db')

    def test_backup_contains_only_database_and_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in ['runtime','data/backend','data/uploads']:
                (root/folder).mkdir(parents=True,exist_ok=True)
            (root/'runtime/secret').write_text('must-not-be-archived')
            (root/'data/uploads/photo.txt').write_text('project media')
            def dump(env, action, output):
                self.assertEqual(action,'dump')
                output.write(b'PGDMP fixture')
            with patch.object(backup,'config',return_value={}), patch.object(backup,'database',side_effect=dump):
                backup.backup(root)
            with tarfile.open(next((root/'backups').glob('*.tar.gz'))) as tar:
                backup.validate_archive(tar)
                self.assertNotIn('runtime/secret',tar.getnames())
                self.assertIn('media/uploads/photo.txt',tar.getnames())

    def test_preflight_only_inspects_expected_containers_and_networks(self):
        network = {'Driver':'bridge','Containers':{'database-id':{},'edge-id':{}}}
        seen=[]
        def inspect_output(args, **kwargs):
            seen.append(args)
            identity = 'database-id' if args[-1]=='db' else 'edge-id'
            return json.dumps([{'Id':identity,'State':{'Running':True},'Config':{'Env':['SECRET=must-not-print']}}])
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'runtime').mkdir()
            (root/'runtime/compose.env').write_text('DB_NETWORK=database\nPROXY_NETWORK=edge\nDB_CONTAINER=db\nEDGE_PROXY_CONTAINER=proxy\n')
            with patch.object(preflight,'inspect',return_value=network),patch.object(preflight.subprocess,'check_output',side_effect=inspect_output):
                preflight.check(root)
            self.assertTrue(all(command[:2]==['docker','inspect'] for command in seen))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'runtime').mkdir()
            (root/'runtime/compose.env').write_text('DB_NETWORK=database\nPROXY_NETWORK=edge\nDB_CONTAINER=db\nEDGE_PROXY_CONTAINER=proxy\n')
            with patch.object(preflight,'inspect',return_value={**network,'Containers':{}}),patch.object(preflight.subprocess,'check_output',side_effect=inspect_output):
                with self.assertRaisesRegex(ValueError,'different network'):
                    preflight.check(root)

if __name__=='__main__':
    unittest.main()
