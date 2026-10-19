*** Settings ***
Documentation     End-to-end tests of the Finance Tracker UI (Robot Framework + SeleniumLibrary).
...               Run `python robot/build_test_site.py` first, then `robot --outputdir robot/results robot/tests`.
Resource          ../resources/common.resource
Suite Setup       Start Test Server
Suite Teardown    Stop Test Server
