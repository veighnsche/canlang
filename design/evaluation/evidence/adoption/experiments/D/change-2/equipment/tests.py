import csv
import io
from django.contrib.auth import get_user_model
from django.test import TestCase
from .models import Company, Department, Membership, Request, Evidence
from . import service
from .chat_auth import issue_token, token_user


class EquipmentExpectations(TestCase):
    def setUp(self):
        company = Company.objects.create(name="Company P")
        self.a, self.b, self.c = [Department.objects.create(company=company, code=x) for x in "ABC"]
        User = get_user_model()
        self.owner = User.objects.create_user(username="owner@example.test", email="owner@example.test", password="test-secret-123")
        self.peer = User.objects.create_user(username="peer@example.test", password="test-secret-123")
        self.manager = User.objects.create_user(username="manager@example.test", password="test-secret-123", is_staff=True)
        self.finance = User.objects.create_user(username="finance@example.test", password="test-secret-123", is_superuser=True)
        for user, dept in [(self.owner,self.a),(self.peer,self.b),(self.manager,self.a),(self.finance,self.c)]:
            Membership.objects.create(user=user, department=dept)
        self.a.managers.add(self.manager)

    def create(self, owner=None, **values):
        return service.mutate(owner or self.owner, "create", {"title": " Laptop ", "details": "", "private": False, **values})

    def test_create_trims_and_derives_owner_department(self):
        row = self.create()
        self.assertEqual((row["title"],row["owner_id"],row["department"],row["version"]),
                         ("Laptop",self.owner.pk,"A",1))
        with self.assertRaises(service.Failure):
            service.mutate(self.owner,"create",{"title":"Phone","owner":self.peer.pk})
        self.assertEqual(Request.objects.count(),1)

    def test_own_update_and_stale_conflict(self):
        row=self.create()
        updated=service.mutate(self.owner,"update",{"title":"Dock","details":"USB-C","private":True},row["id"],1)
        self.assertEqual((updated["title"],updated["version"]),("Dock",2))
        with self.assertRaises(service.Failure) as failure:
            service.mutate(self.owner,"update",{"title":"Stale"},row["id"],1)
        self.assertEqual(failure.exception.status,409)
        self.assertEqual(Request.objects.get(pk=row["id"]).title,"Dock")

    def test_other_employee_and_manager_cannot_mutate_claims(self):
        row=self.create()
        for user in (self.peer,self.manager,self.finance):
            with self.assertRaises(service.Failure):
                service.mutate(user,"update",{"title":"Changed"},row["id"],1)
        self.assertEqual(Request.objects.get(pk=row["id"]).title,"Laptop")

    def test_manager_scope_and_private_owner_access(self):
        public=self.create()
        self.create(private=True,title="Private")
        self.create(self.peer,title="Other department")
        self.assertEqual([r["id"] for r in service.listing(self.manager)],[public["id"]])
        self.assertEqual(len(service.listing(self.owner)),2)
        self.assertEqual(service.listing(self.finance),[])
        with self.assertRaises(service.Failure):
            service.visible(self.peer,public["id"])

    def test_invalid_title(self):
        for title in ("", "   ", "x"*121):
            with self.assertRaises(service.Failure):
                self.create(title=title)
        self.assertEqual(Request.objects.count(),0)

    def test_archive_preserves_evidence_and_blocks_later_update(self):
        row=self.create(details="Original evidence")
        archived=service.mutate(self.owner,"archive",request_id=row["id"],version=1,reason=" No longer needed ")
        self.assertEqual((archived["state"],archived["version"],archived["details"]),("archived",2,"Original evidence"))
        self.assertEqual(Evidence.objects.filter(request_id=row["id"]).count(),2)
        with self.assertRaises(service.Failure):
            service.mutate(self.owner,"update",{"title":"No"},row["id"],2)
        self.assertEqual(service.listing(self.owner,state="open"),[])

    def test_scoped_export_uses_same_disclosure(self):
        self.create(title="=unsafe")
        self.create(title="Secret",private=True)
        self.create(self.peer,title="Unrelated")
        rows=list(csv.DictReader(io.StringIO(service.export_csv(self.manager))))
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]["Request"],"'=unsafe")
        self.assertEqual(service.listing(self.manager,department="B"),[])

    def test_preview_correct_exclude_and_partial_intake(self):
        self.create(title="Existing")
        batch=service.intake_preview(self.owner,"title,details,private,cost_centre\nExisting,,false,\n  ,,false,\nNew,,true,\nNew,,true,\n")
        self.assertEqual([r["status"] for r in batch["rows"]],["duplicate","invalid","ready","duplicate"])
        self.assertEqual(Request.objects.count(),1)
        # Correct the invalid title, exclude the first of the duplicate pair.
        rows=[{k:r[k] for k in ("title","details","private","cost_centre","include")} for r in batch["rows"]]
        rows[1]["title"]="Corrected"
        rows[2]["include"]=False
        updated=service.intake_correct(self.owner,batch["id"],1,rows)
        self.assertEqual(updated["rows"][3]["status"],"ready")
        result=service.intake_commit(self.owner,batch["id"],updated["version"])
        self.assertEqual([r["status"] for r in result["outcomes"]],["duplicate","created","excluded","created"])
        self.assertEqual(Request.objects.count(),3)
        self.assertTrue(all(r.owner_id==self.owner.pk and r.department_id==self.a.pk for r in Request.objects.all()))
        with self.assertRaises(service.Failure) as conflict:
            service.intake_commit(self.owner,batch["id"],updated["version"])
        self.assertEqual(conflict.exception.status,409)

    def test_invalid_rows_reported_at_commit(self):
        batch=service.intake_preview(self.owner,"title,details,private,cost_centre\n,,false,\nGood,,false,\n")
        result=service.intake_commit(self.owner,batch["id"],batch["version"])
        self.assertEqual([r["status"] for r in result["outcomes"]],["invalid","created"])

    def test_intake_owner_and_current_membership(self):
        batch=service.intake_preview(self.owner,"title,details,private,cost_centre\nNew,,false,\n")
        with self.assertRaises(service.Failure):
            service.own_batch(self.peer,batch["id"])
        membership=Membership.objects.get(user=self.owner)
        membership.department=self.b
        membership.save()
        result=service.intake_commit(self.owner,batch["id"],1)
        self.assertEqual(result["outcomes"][0]["request"]["department"],"B")

    def test_chat_token_rechecks_revocation_and_password(self):
        token=issue_token(self.owner)
        self.assertEqual(token_user(token).pk,self.owner.pk)
        self.owner.set_password("changed-password-123")
        self.owner.save()
        with self.assertRaises(service.Failure):
            token_user(token)
        token=issue_token(self.owner)
        Membership.objects.filter(user=self.owner).update(active=False)
        with self.assertRaises(service.Failure):
            token_user(token)
        with self.assertRaises(service.Failure):
            service.listing(self.owner)

    def test_browser_email_login_and_create(self):
        response=self.client.post("/accounts/login/",{"username":"OWNER@example.test","password":"test-secret-123"})
        self.assertEqual(response.status_code,302)
        response=self.client.post("/new/",{"title":"Browser","details":"","version":1})
        self.assertEqual(response.status_code,302)
        self.assertEqual(Request.objects.get().owner_id,self.owner.pk)

    def test_browser_conflict_has_accessible_message(self):
        row=self.create()
        self.client.force_login(self.owner)
        service.mutate(self.owner,"archive",request_id=row["id"],version=1,reason=" No longer needed ")
        response=self.client.post(f"/{row['id']}/archive/",{"version":1})
        self.assertEqual(response.status_code,409)
        self.assertContains(response,'role="alert"',status_code=409)

    def test_archive_reason_required_and_retained_immutably(self):
        row=self.create()
        for reason in ("", "  "):
            with self.assertRaises(service.Failure):
                service.mutate(self.owner,"archive",request_id=row["id"],version=1,reason=reason)
        self.assertEqual(Request.objects.get(pk=row["id"]).state,"open")
        result=service.mutate(self.owner,"archive",request_id=row["id"],version=1,reason="  Replaced  ")
        self.assertEqual(result["archive_reason"],"Replaced")
        event=Evidence.objects.get(request_id=row["id"],action="archive")
        self.assertEqual(event.snapshot["archive_reason"],"Replaced")
        with self.assertRaises(service.Failure):
            service.mutate(self.owner,"archive",request_id=row["id"],version=2,reason="Changed")
        self.assertEqual(Request.objects.get(pk=row["id"]).archive_reason,"Replaced")

    def test_details_cost_centre_and_narrowed_request_limit(self):
        row=self.create(details="Existing text",cost_centre="x"*40,title="x"*120)
        self.assertEqual((row["details"],row["cost_centre"]),("Existing text","x"*40))
        for values in ({"title":"x"*121},{"cost_centre":"x"*41}):
            with self.assertRaises(service.Failure):
                self.create(**values)
        with self.assertRaises(service.Failure):
            service.mutate(self.owner,"create",{"title":"Legacy input","note":"No alias"})
        self.assertIn("cost_centre",service.export_csv(self.owner).splitlines()[0])
