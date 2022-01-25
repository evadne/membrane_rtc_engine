Code.require_file("../test_videoroom/test/support/integration_mustang.exs")

defmodule TestVideoroom.Integration.ClientTest do
  use TestVideoroomWeb.ConnCase, async: false
  @peers 4
  # in miliseconds
  @peer_delay 500
  # in miliseconds
  @peer_duration 50_000
  @room_url "http://localhost:4000"

  # in miliseconds
  @browser_delay 2_000

  @start_with_all "start-all"
  @start_with_mic "start-mic-only"
  @start_with_camera "start-camera-only"
  @start_with_nothing "start-none"
  @stop_button "stop"
  @stats_button "stats"

  @moduletag timeout: 180_000
  test "Users gradually joining and leaving can hear and see each other" do
    options = %{count: 1, delay: @peer_delay}
    browsers_number = 4

    pid = self()

    receiver = Process.spawn(fn -> receive_stats(browsers_number, pid) end, [:link])

    mustang_options = %{
      target_url: @room_url,
      linger: @peer_duration,
      join_interval: 10_000,
      start_button: @start_with_all,
      receiver: receiver,
      id: -1
    }

    for browser <- 0..(browsers_number - 1), into: [] do
      mustang_options = %{mustang_options | id: browser}
      task = Task.async(fn -> Stampede.start({IntegrationMustang, mustang_options}, options) end)
      Process.sleep(5_000)
      task
    end
    |> Task.await_many(:infinity)

    receive do
      acc ->
        Enum.all?(acc, fn {stage, browsers} ->
          case stage do
            :after_join ->
              Enum.all?(browsers, fn {browser_id, stats} ->
                assert length(stats) == browser_id
                assert Enum.all?(stats, &is_stream_playing(&1))
                true
              end)

            :before_leave ->
              Enum.all?(browsers, fn {browser_id, stats} ->
                assert length(stats) == browsers_number - browser_id - 1
                assert Enum.all?(stats, &is_stream_playing(&1))
              end)
          end
        end)
    end
  end

  @moduletag timeout: 180_000
  test "Users joining all at once can hear and see each other" do
    options = %{count: 1, delay: @peer_delay}
    browsers_number = 4

    pid = self()

    receiver = Process.spawn(fn -> receive_stats(browsers_number, pid) end, [:link])

    mustang_options = %{
      target_url: @room_url,
      linger: @peer_duration,
      join_interval: 15_000,
      start_button: @start_with_all,
      receiver: receiver,
      id: -1
    }

    for browser <- 0..(browsers_number - 1), into: [] do
      mustang_options = %{mustang_options | id: browser}
      Task.async(fn -> Stampede.start({IntegrationMustang, mustang_options}, options) end)
    end
    |> Task.await_many(:infinity)

    receive do
      acc ->
        Enum.all?(acc, fn {stage, browsers} ->
          case stage do
            :after_join ->
              Enum.all?(browsers, fn {browser_id, stats} ->
                assert length(stats) == browsers_number - 1
                assert Enum.all?(stats, &is_stream_playing(&1))
              end)

            :before_leave ->
              true
          end
        end)
    end
  end

  @moduletag timeout: 180_000
  test "Users joining without either microphone, camera or both can see or hear other users" do
    options = %{count: 1, delay: @peer_delay}
    browsers_number = 4

    pid = self()

    receiver = Process.spawn(fn -> receive_stats(browsers_number, pid) end, [:link])

    mustang_options = %{
      target_url: @room_url,
      linger: @peer_duration,
      join_interval: 10_000,
      start_button: @start_with_all,
      receiver: receiver,
      id: -1
    }

    buttons_with_id = Enum.with_index([@start_with_all, @start_with_camera, @start_with_mic])

    for {button, browser_id} <- buttons_with_id, into: [] do
      specific_mustang = %{mustang_options | start_button: button, id: browser_id}
      Task.async(fn -> Stampede.start({IntegrationMustang, specific_mustang}, options) end)
    end
    |> Task.await_many(:infinity)

    buttons = Map.new(buttons_with_id, fn {button, browser_id} -> {browser_id, button} end)

    receive do
      acc ->
        Enum.all?(acc, fn {stage, browsers} ->
          case stage do
            :after_join ->
              Enum.all?(browsers, fn {browser_id, stats} ->
                IO.inspect({browser_id, stats})
                assert length(stats) == if(browser_id == 3, do: 3, else: 2)
                {_value, new_buttons} = Map.pop(buttons, browser_id)
                new_buttons = Map.values(new_buttons)
                assert which_streams_playing(stats, new_buttons)
              end)

            :before_leave ->
              true
          end
        end)
    end
  end

  defp receive_stats(mustangs_number, pid, acc \\ %{}) do
    if mustangs_number > 0 do
      receive do
        {_browser_id, :end} ->
          receive_stats(mustangs_number - 1, pid, acc)

        {browser_id, stage, data} ->
          acc
          |> then(fn acc ->
            default_map = %{browser_id => data}
            Map.update(acc, stage, default_map, &Map.put(&1, browser_id, data))
          end)
          |> then(&receive_stats(mustangs_number, pid, &1))
      end
    else
      send(pid, acc)
    end
  end

  defp which_streams_playing(stats, buttons) do
    for button <- buttons do
      case button do
        @start_with_all ->
          assert Enum.any?(stats, &is_stream_playing(&1))

        @start_with_camera ->
          assert Enum.any?(stats, &is_stream_playing(&1, %{audio: false, video: true}))

        @start_with_mic ->
          assert Enum.any?(stats, &is_stream_playing(&1, %{audio: true, video: false}))

        @start_with_nothing ->
          assert Enum.any?(stats, &is_stream_playing(&1, %{audio: false, video: false}))
      end
    end

    true
  end

  defp is_stream_playing(stats, expected \\ %{audio: true, video: true})

  defp is_stream_playing(
         %{"streamId" => _, "isAudioPlaying" => audio, "isVideoPlaying" => video},
         %{audio: expected_audio, video: expected_video}
       ),
       do: audio == expected_audio and video == expected_video
end
