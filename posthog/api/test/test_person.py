import json
import unittest
from unittest import mock
from uuid import uuid4

from django.utils import timezone
from freezegun import freeze_time
from rest_framework import status

from ee.clickhouse.client import sync_execute
from ee.clickhouse.models.event import create_event
from ee.clickhouse.util import ClickhouseTestMixin
from posthog.models import Cohort, Organization, Person, Team
from posthog.models.person import PersonDistinctId
from posthog.test.base import APIBaseTest


def _create_event(**kwargs):
    kwargs.update({"event_uuid": uuid4()})
    create_event(**kwargs)


def _create_person(**kwargs):
    return Person.objects.create(**kwargs)


class TestPerson(ClickhouseTestMixin, APIBaseTest):
    def test_search(self) -> None:
        _create_person(
            team=self.team, distinct_ids=["distinct_id"], properties={"email": "someone@gmail.com"},
        )
        _create_person(
            team=self.team, distinct_ids=["distinct_id_2"], properties={"email": "another@gmail.com", "name": "james"},
        )
        _create_person(team=self.team, distinct_ids=["distinct_id_3"], properties={"name": "jane"})

        response = self.client.get("/api/person/?search=another@gm")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)

        response = self.client.get("/api/person/?search=_id_3")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)

    def test_properties(self) -> None:
        _create_person(
            team=self.team, distinct_ids=["distinct_id"], properties={"email": "someone@gmail.com"},
        )
        _create_person(
            team=self.team, distinct_ids=["distinct_id_2"], properties={"email": "another@gmail.com"},
        )
        _create_person(team=self.team, distinct_ids=["distinct_id_3"], properties={})

        response = self.client.get(
            "/api/person/?properties=%s"
            % json.dumps([{"key": "email", "operator": "is_set", "value": "is_set", "type": "person"}])
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 2)

        response = self.client.get(
            "/api/person/?properties=%s"
            % json.dumps([{"key": "email", "operator": "icontains", "value": "another@gm", "type": "person"}])
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)

    def test_person_property_names(self) -> None:
        _create_person(team=self.team, properties={"$browser": "whatever", "$os": "Mac OS X"})
        _create_person(team=self.team, properties={"random_prop": "asdf"})
        _create_person(team=self.team, properties={"random_prop": "asdf"})

        response = self.client.get("/api/person/properties/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        response_data = response.json()
        self.assertEqual(response_data[0]["name"], "random_prop")
        self.assertEqual(response_data[0]["count"], 2)
        self.assertEqual(response_data[2]["name"], "$os")
        self.assertEqual(response_data[2]["count"], 1)
        self.assertEqual(response_data[1]["name"], "$browser")
        self.assertEqual(response_data[1]["count"], 1)

    def test_person_property_values(self):
        _create_person(
            team=self.team, properties={"random_prop": "asdf", "some other prop": "with some text"},
        )
        _create_person(team=self.team, properties={"random_prop": "asdf"})
        _create_person(team=self.team, properties={"random_prop": "qwerty"})
        _create_person(team=self.team, properties={"something_else": "qwerty"})
        response = self.client.get("/api/person/values/?key=random_prop")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        response_data = response.json()
        self.assertEqual(response_data[0]["name"], "asdf")
        self.assertEqual(response_data[0]["count"], 2)
        self.assertEqual(response_data[1]["name"], "qwerty")
        self.assertEqual(response_data[1]["count"], 1)
        self.assertEqual(len(response_data), 2)

        response = self.client.get("/api/person/values/?key=random_prop&value=qw")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()[0]["name"], "qwerty")
        self.assertEqual(response.json()[0]["count"], 1)

    def test_filter_by_cohort(self):

        _create_person(
            team=self.team, distinct_ids=[f"fake"], properties={},
        )
        for i in range(150):
            _create_person(
                team=self.team, distinct_ids=[f"person_{i}"], properties={"$os": "Chrome"},
            )

        cohort = Cohort.objects.create(team=self.team, groups=[{"properties": {"$os": "Chrome"}}])
        cohort.calculate_people_ch(pending_version=0)

        response = self.client.get(f"/api/cohort/{cohort.pk}/persons")
        self.assertEqual(len(response.json()["results"]), 100, response)

        response = self.client.get(response.json()["next"])
        self.assertEqual(len(response.json()["results"]), 50, response)

    def test_filter_by_static_cohort(self):
        Person.objects.create(team_id=self.team.pk, distinct_ids=["1"])
        Person.objects.create(team_id=self.team.pk, distinct_ids=["123"])
        Person.objects.create(team_id=self.team.pk, distinct_ids=["2"])
        # Team leakage
        team2 = Team.objects.create(organization=self.organization)
        Person.objects.create(team=team2, distinct_ids=["1"])

        cohort = Cohort.objects.create(team=self.team, groups=[], is_static=True, last_calculation=timezone.now(),)
        cohort.insert_users_by_list(["1", "123"])

        response = self.client.get(f"/api/cohort/{cohort.pk}/persons")
        self.assertEqual(len(response.json()["results"]), 2, response)

    def test_filter_person_list(self):

        person1: Person = _create_person(
            team=self.team,
            distinct_ids=["distinct_id", "another_one"],
            properties={"email": "someone@gmail.com"},
            is_identified=True,
        )
        person2: Person = _create_person(
            team=self.team, distinct_ids=["distinct_id_2"], properties={"email": "another@gmail.com"},
        )

        # Filter by distinct ID
        with self.assertNumQueries(6):
            response = self.client.get("/api/person/?distinct_id=distinct_id")  # must be exact matches
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)
        self.assertEqual(response.json()["results"][0]["id"], person1.pk)

        response = self.client.get("/api/person/?distinct_id=another_one")  # can search on any of the distinct IDs
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)
        self.assertEqual(response.json()["results"][0]["id"], person1.pk)

        # Filter by email
        response = self.client.get("/api/person/?email=another@gmail.com")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)
        self.assertEqual(response.json()["results"][0]["id"], person2.pk)

        # Filter by key identifier
        for _identifier in ["another@gmail.com", "distinct_id_2"]:
            response = self.client.get(f"/api/person/?key_identifier={_identifier}")
            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(len(response.json()["results"]), 1)
            self.assertEqual(response.json()["results"][0]["id"], person2.pk)

        # Non-matches return an empty list
        response = self.client.get("/api/person/?email=inexistent")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 0)

        response = self.client.get("/api/person/?distinct_id=inexistent")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 0)

    def test_cant_see_another_organization_pii_with_filters(self):

        # Completely different organization
        another_org: Organization = Organization.objects.create()
        another_team: Team = Team.objects.create(organization=another_org)
        _create_person(
            team=another_team, distinct_ids=["distinct_id", "x_another_one"],
        )
        _create_person(
            team=another_team, distinct_ids=["x_distinct_id_2"], properties={"email": "team2_another@gmail.com"},
        )

        # Person in current team
        person: Person = _create_person(
            team=self.team, distinct_ids=["distinct_id"],
        )

        # Filter by distinct ID
        response = self.client.get("/api/person/?distinct_id=distinct_id")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.json()["results"]), 1)
        self.assertEqual(
            response.json()["results"][0]["id"], person.pk,
        )  # note that even with shared distinct IDs, only the person from the same team is returned

        response = self.client.get("/api/person/?distinct_id=x_another_one")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json()["results"], [])

        # Filter by key identifier
        for _identifier in ["x_another_one", "distinct_id_2"]:
            response = self.client.get(f"/api/person/?key_identifier={_identifier}")
            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(response.json()["results"], [])

    def test_delete_person(self):
        person = _create_person(
            team=self.team, distinct_ids=["person_1", "anonymous_id"], properties={"$os": "Chrome"},
        )
        _create_event(event="test", team=self.team, distinct_id="person_1")
        _create_event(event="test", team=self.team, distinct_id="anonymous_id")
        _create_event(event="test", team=self.team, distinct_id="someone_else")

        response = self.client.delete(f"/api/person/{person.pk}/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(response.content, b"")  # Empty response
        self.assertEqual(Person.objects.filter(team=self.team).count(), 0)

        response = self.client.delete(f"/api/person/{person.pk}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_filter_uuid(self) -> None:
        person1 = _create_person(team=self.team, properties={"$browser": "whatever", "$os": "Mac OS X"})
        person2 = _create_person(team=self.team, properties={"random_prop": "asdf"})
        _create_person(team=self.team, properties={"random_prop": "asdf"})

        response = self.client.get(f"/api/person/?uuid={person1.uuid},{person2.uuid}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["results"]), 2)

    @mock.patch("posthog.api.capture.capture_internal")
    def test_merge_people(self, mock_capture_internal) -> None:
        # created first
        person3 = _create_person(team=self.team, distinct_ids=["distinct_id_3"], properties={"oh": "hello"})
        person1 = _create_person(
            team=self.team, distinct_ids=["1"], properties={"$browser": "whatever", "$os": "Mac OS X"}
        )
        person2 = _create_person(team=self.team, distinct_ids=["2"], properties={"random_prop": "asdf"})

        response = self.client.post("/api/person/%s/merge/" % person1.pk, {"ids": [person2.pk, person3.pk]},)
        mock_capture_internal.assert_has_calls(
            [
                mock.call(
                    {"event": "$create_alias", "properties": {"alias": "2"}},
                    "1",
                    None,
                    None,
                    unittest.mock.ANY,
                    unittest.mock.ANY,
                    self.team.id,
                ),
                mock.call(
                    {"event": "$create_alias", "properties": {"alias": "distinct_id_3"}},
                    "1",
                    None,
                    None,
                    unittest.mock.ANY,
                    unittest.mock.ANY,
                    self.team.id,
                ),
            ],
            any_order=True,
        )
        self.assertEqual(response.status_code, 201)
        self.assertCountEqual(response.json()["distinct_ids"], ["1", "2", "distinct_id_3"])

    def test_split_people_keep_props(self) -> None:
        # created first
        person1 = _create_person(
            team=self.team, distinct_ids=["1", "2", "3"], properties={"$browser": "whatever", "$os": "Mac OS X"}
        )

        self.client.post(
            "/api/person/%s/split/" % person1.pk, {"main_distinct_id": "1"},
        )

        people = Person.objects.all().order_by("id")
        self.assertEqual(people.count(), 3)
        self.assertEqual(people[0].distinct_ids, ["1"])
        self.assertEqual(people[0].properties, {"$browser": "whatever", "$os": "Mac OS X"})
        self.assertEqual(people[1].distinct_ids, ["2"])
        self.assertEqual(people[2].distinct_ids, ["3"])

    def test_split_people_delete_props(self) -> None:
        # created first
        person1 = _create_person(
            team=self.team, distinct_ids=["1", "2", "3"], properties={"$browser": "whatever", "$os": "Mac OS X"}
        )

        response = self.client.post("/api/person/%s/split/" % person1.pk,)
        people = Person.objects.all().order_by("id")
        self.assertEqual(people.count(), 3)
        self.assertEqual(people[0].distinct_ids, ["1"])
        self.assertEqual(people[0].properties, {})
        self.assertEqual(people[1].distinct_ids, ["2"])
        self.assertEqual(people[2].distinct_ids, ["3"])
        self.assertTrue(response.json()["success"])

    def test_return_non_anonymous_name(self) -> None:
        _create_person(
            team=self.team,
            distinct_ids=["distinct_id1", "17787c3099427b-0e8f6c86323ea9-33647309-1aeaa0-17787c30995b7c"],
        )
        _create_person(
            team=self.team, distinct_ids=["17787c327b-0e8f623ea9-336473-1aeaa0-17787c30995b7c", "distinct_id2"],
        )

        response = self.client.get("/api/person/").json()

        self.assertEqual(response["results"][0]["name"], "distinct_id2")
        self.assertEqual(response["results"][1]["name"], "distinct_id1")

        self.assertEqual(
            response["results"][0]["distinct_ids"],
            ["distinct_id2", "17787c327b-0e8f623ea9-336473-1aeaa0-17787c30995b7c"],
        )
        self.assertEqual(
            response["results"][1]["distinct_ids"],
            ["distinct_id1", "17787c3099427b-0e8f6c86323ea9-33647309-1aeaa0-17787c30995b7c"],
        )

    def test_person_cohorts(self) -> None:
        _create_person(team=self.team, distinct_ids=["1"], properties={"$some_prop": "something", "number": 1})
        person2 = _create_person(
            team=self.team, distinct_ids=["2"], properties={"$some_prop": "something", "number": 2}
        )
        cohort1 = Cohort.objects.create(
            team=self.team, groups=[{"properties": {"$some_prop": "something"}}], name="cohort1"
        )
        cohort2 = Cohort.objects.create(team=self.team, groups=[{"properties": {"number": 1}}], name="cohort2")
        cohort3 = Cohort.objects.create(team=self.team, groups=[{"properties": {"number": 2}}], name="cohort3")
        cohort1.calculate_people_ch(pending_version=0)
        cohort2.calculate_people_ch(pending_version=0)
        cohort3.calculate_people_ch(pending_version=0)

        response = self.client.get(f"/api/person/cohorts/?person_id={person2.id}").json()
        response["results"].sort(key=lambda cohort: cohort["name"])
        self.assertEqual(len(response["results"]), 2)
        self.assertDictContainsSubset({"id": cohort1.id, "count": 2, "name": cohort1.name}, response["results"][0])
        self.assertDictContainsSubset({"id": cohort3.id, "count": 1, "name": cohort3.name}, response["results"][1])

    def test_split_person_clickhouse(self):
        person = _create_person(
            team=self.team, distinct_ids=["1", "2", "3"], properties={"$browser": "whatever", "$os": "Mac OS X"}
        )

        response = self.client.post("/api/person/%s/split/" % person.pk,).json()
        self.assertTrue(response["success"])

        people = Person.objects.all().order_by("id")
        clickhouse_people = sync_execute(
            "SELECT id FROM person FINAL WHERE team_id = %(team_id)s", {"team_id": self.team.pk}
        )
        self.assertCountEqual(clickhouse_people, [(person.uuid,) for person in people])

        distinct_id_rows = PersonDistinctId.objects.all().order_by("person_id")
        pdis = sync_execute(
            "SELECT person_id, distinct_id FROM person_distinct_id FINAL WHERE team_id = %(team_id)s",
            {"team_id": self.team.pk},
        )
        self.assertCountEqual(pdis, [(pdi.person.uuid, pdi.distinct_id) for pdi in distinct_id_rows])

        pdis2 = sync_execute(
            "SELECT person_id, distinct_id FROM person_distinct_id2 FINAL WHERE team_id = %(team_id)s",
            {"team_id": self.team.pk},
        )
        self.assertCountEqual(pdis2, [(pdi.person.uuid, pdi.distinct_id) for pdi in distinct_id_rows])

    def test_csv_export(self):
        _create_person(
            team=self.team, distinct_ids=["1", "2", "3"], properties={"$browser": "whatever", "$os": "Mac OS X"}
        )
        _create_person(team=self.team, distinct_ids=["4"], properties={"$browser": "whatever", "$os": "Windows"})

        response = self.client.get("/api/person.csv")
        self.assertEqual(len(response.content.splitlines()), 3, response.content)

        response = self.client.get(
            "/api/person.csv?properties=%s" % json.dumps([{"key": "$os", "value": "Windows", "type": "person"}])
        )
        self.assertEqual(len(response.content.splitlines()), 2)

    def test_pagination_limit(self):
        for index in range(0, 20):
            _create_person(
                team=self.team, distinct_ids=[str(index + 100)], properties={"$browser": "whatever", "$os": "Windows"}
            )
        response = self.client.get("/api/person/?limit=10").json()
        self.assertEqual(len(response["results"]), 10)
