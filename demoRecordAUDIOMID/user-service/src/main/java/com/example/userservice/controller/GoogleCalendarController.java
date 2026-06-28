package com.example.userservice.controller;



import org.springframework.http.HttpStatus;

import org.springframework.web.bind.annotation.GetMapping;

import org.springframework.web.bind.annotation.PostMapping;

import org.springframework.web.bind.annotation.RequestMapping;

import org.springframework.web.bind.annotation.RestController;

import org.springframework.web.server.ResponseStatusException;



/**

 * Deprecated: use meeting-service {@code /meetings/google/*} as the single public Google Calendar API.

 */

@RestController

@RequestMapping("/api/google")

public class GoogleCalendarController {



    @GetMapping("/calendar/list")

    public void listCalendars() {

        throw deprecated();

    }



    @PostMapping("/meet/create")

    public void createMeet() {

        throw deprecated();

    }



    private static ResponseStatusException deprecated() {

        return new ResponseStatusException(

                HttpStatus.GONE,

                "Use meeting-service endpoints: GET /meetings/google/calendars and POST /meetings/google/meet"

        );

    }

}


